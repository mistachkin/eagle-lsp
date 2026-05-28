#!/usr/bin/env python3
"""Extract Eagle command and procedure data from documentation sources."""

import json
import re
import os
from html.parser import HTMLParser

DOCS_DIR = "/path/to/eagle-docs"
REPO_DIR = "/tmp/eagle-docs-repo"
OUT_DIR = "/path/to/eagle-lsp/data"

# ── HTML Parser ──────────────────────────────────────────────────────────────

class CommandHTMLParser(HTMLParser):
    """Stateful HTML parser that pulls structured fields from a command page.

    Specializes html.parser.HTMLParser to walk a generated Eagle command
    documentation page (one HTML file per command) and accumulate the
    structured fields the LSP cares about: a one-line 'brief'
    description, a synopsis, a list of subcommands, a list of options,
    a richer multi-paragraph description, group classification, and
    example snippets.

    The page layout assumed by this parser is a series of '<h2>' section
    headings ('NAME', 'GROUP', 'SYNOPSIS', 'SUBCOMMANDS', 'OPTIONS',
    'DESCRIPTION', 'EXAMPLES', ...) interleaved with class-tagged
    '<div>' and '<ul>' wrappers ('synopsis', 'subcommands', 'options',
    'description', 'example').  Section detection is performed on the
    fly with a stack of currently open tags and a constellation of
    boolean 'in_X' flags so handle_data() can decide which collector to
    append to.

    Note that for the synopsis specifically, the regex-based
    extract_synopsis_from_html() is preferred over this incremental
    extraction because '<br>'-separated synopsis lines are awkward to
    capture cleanly through the streaming HTMLParser interface; the
    fields populated here for synopsis_lines are kept for completeness
    but the consumer overrides them with the regex result.

    Attributes:
        section: Uppercased text of the most recent '<h2>' heading, used
            to disambiguate which kind of content the parser is in.
        in_synopsis, in_subcommands, in_options, in_description,
        in_example: Booleans toggled on the matching '<div>' or '<ul>'
            wrapper tag (by class name).
        in_code, in_dd, in_p: Booleans toggled on the corresponding
            inline tags ('<code>', '<dd>', '<p>').
        tag_stack: List of currently open tag names, in nesting order.
        brief: One-line description pulled from the NAME section.
        synopsis_lines: Accumulator for the SYNOPSIS section (unused;
            see note above).
        group: The text content of the GROUP section.
        subcommands: List of subcommand names collected from the
            subcommands list.
        options: List of option flag names collected from the options
            list.
        description_parts: Text fragments collected from the DESCRIPTION
            section's definition-list bodies.
        example_parts: Text fragments collected from any example
            wrapper.
    """
    def __init__(self):
        """Initialize all collectors and flags to empty state.

        Called once per HTML file being parsed.  Resets every flag to
        False and every collector to an empty container so the parser
        can be reused across files without carrying state between them.
        """
        super().__init__()
        self.section = None
        self.in_synopsis = False
        self.in_subcommands = False
        self.in_options = False
        self.in_description = False
        self.in_code = False
        self.in_dd = False
        self.in_p = False
        self.in_example = False
        self.tag_stack = []

        self.brief = ""
        self.synopsis_lines = []
        self.group = ""
        self.subcommands = []
        self.options = []
        self.description_parts = []
        self.example_parts = []

    def handle_starttag(self, tag, attrs):
        """React to an opening HTML tag by updating section flags.

        Pushes the tag onto tag_stack (so handle_data can ask 'am I
        inside an h2 right now?') and then turns on the appropriate
        'in_X' flag based on the tag name and its 'class' attribute.
        '<h2>' specifically resets _h2_text so the heading text can be
        collected fresh in handle_data and the section label computed
        once the heading closes.

        Tricky details:
            - The 'class' attribute is looked up with substring
              containment ('synopsis' in cls), not equality, so the
              parser will still trip on classes like 'synopsis-inline'.
              That has not been a problem with the generator's output
              but is worth knowing if the markup changes.
            - 'div' is overloaded: synopsis, description, and example
              all use a 'div' wrapper distinguished only by class, so
              handle_endtag has to clear all three flags whenever any
              'div' closes (we cannot tell which one is closing just
              from the tag name).

        Args:
            tag: Lower-cased element name reported by the base parser.
            attrs: List of (name, value) attribute pairs for this tag.
        """
        cls = dict(attrs).get("class", "")
        self.tag_stack.append(tag)
        if tag == "h2":
            self._h2_text = ""
        elif tag == "div" and "synopsis" in cls:
            self.in_synopsis = True
        elif tag == "ul" and "subcommands" in cls:
            self.in_subcommands = True
        elif tag == "ul" and "options" in cls:
            self.in_options = True
        elif tag == "div" and "description" in cls:
            self.in_description = True
        elif tag == "div" and "example" in cls:
            self.in_example = True
        elif tag == "code":
            self.in_code = True
        elif tag == "dd":
            self.in_dd = True
        elif tag == "p":
            self.in_p = True

    def handle_endtag(self, tag):
        """React to a closing HTML tag by clearing section flags.

        Pops the tag stack and, for tags that act as section delimiters,
        clears the matching boolean flag so subsequent data callbacks
        no longer get routed to that section's collector.  For '<h2>'
        specifically, the accumulated heading text is normalized
        (stripped and upper-cased) into the section attribute, which
        controls how the NAME and GROUP sections are interpreted in
        handle_data.

        Tricky details:
            - All 'div'-classed sections (synopsis, description,
              example) share a single end-tag clear because the parser
              cannot, from the closing '</div>' alone, tell which class
              was on the matching opener.  In practice the page layout
              never nests these sections inside one another, so the
              over-eager clear is harmless.
            - 'ul' clears both subcommands and options for the same
              reason.
            - The tag_stack.pop() guard handles malformed input where
              an end tag appears with no matching opener.

        Args:
            tag: Lower-cased element name reported by the base parser.
        """
        if self.tag_stack:
            self.tag_stack.pop()
        if tag == "h2":
            self.section = getattr(self, '_h2_text', '').strip().upper()
        elif tag == "div":
            self.in_synopsis = False
            self.in_description = False
            self.in_example = False
        elif tag == "ul":
            self.in_subcommands = False
            self.in_options = False
        elif tag == "code":
            self.in_code = False
        elif tag == "dd":
            self.in_dd = False
        elif tag == "p":
            self.in_p = False

    def handle_data(self, data):
        """Route a text fragment to the right collector based on state.

        The big dispatch routine.  Looks at the current section, the
        tag_stack, and the in_X flags to decide which of the parser's
        accumulators (brief, group, subcommands, options,
        description_parts, example_parts) should receive this fragment.

        Behaviors by section:
            - 'h2' anywhere in the tag stack: append to _h2_text so the
              full heading text is available when handle_endtag fires.
            - Section NAME inside a '<p>': try to pull the brief from a
              line of the form 'cmdname -- brief' (em-dash) or
              'cmdname - brief' / 'cmdname -- brief'.  The em-dash form
              wins outright; the dash regex only runs if no brief is
              set yet.
            - Section GROUP inside a '<p>': capture the first non-empty
              text as the group classification.
            - Inside the subcommands/options list and inside '<code>':
              append the trimmed text as a subcommand / option name.
            - Inside the description '<div>' and inside '<dd>': collect
              definition-list bodies as description fragments.
            - Inside the example '<div>': collect every text fragment,
              including whitespace, since example content is later
              joined verbatim.

        Tricky details:
            - The em-dash check uses the Unicode character U+2014
              ('—') because the generator emits a literal em-dash
              between the command name and its brief.  The fallback
              regex also accepts U+2013 (en-dash) and a plain hyphen.
            - Multiple fragments under the same condition are appended
              in order; the caller joins or post-processes them.

        Args:
            data: The raw text fragment as a string.
        """
        if 'h2' in self.tag_stack:
            self._h2_text = getattr(self, '_h2_text', '') + data
            return

        if self.section == "NAME" and self.in_p:
            if "\u2014" in data:
                self.brief = data.split("\u2014", 1)[1].strip()
            elif not self.brief:
                m = re.search(r'\w+\s*[-\u2013]\s*(.+)', data)
                if m:
                    self.brief = m.group(1).strip()

        if self.section == "GROUP" and self.in_p:
            t = data.strip()
            if t and not self.group:
                self.group = t

        if self.in_subcommands and self.in_code:
            t = data.strip()
            if t:
                self.subcommands.append(t)

        if self.in_options and self.in_code:
            t = data.strip()
            if t:
                self.options.append(t)

        if self.in_description and self.in_dd:
            t = data.strip()
            if t:
                self.description_parts.append(t)

        if self.in_example:
            self.example_parts.append(data)


def extract_synopsis_from_html(content):
    """Extract the synopsis block from an HTML page using regex.

    Pulls the inner HTML of the first '<div class="synopsis">' wrapper,
    converts every '<br>' (with or without a trailing slash) into a
    newline, strips all remaining tags, and returns one synopsis line
    per output line with whitespace normalized.  Used in preference to
    the incremental HTMLParser collection because the streaming
    interface makes line breaks awkward to recover when the synopsis is
    laid out as 'cmd args<br>cmd args<br>...' inside a single '<p>'.

    How it works:
        - re.search with DOTALL grabs the first synopsis div, returning
          empty string when no match is found.
        - '<br>' and '<br/>' (with optional whitespace) become newlines
          via a regex substitution.
        - All other tags are stripped with a greedy '[^>]+' match.
        - Each resulting line is stripped, collapsed (runs of
          whitespace become single spaces), and dropped if empty.
        - Surviving lines are joined back with newlines, producing a
          synopsis where each usage variant occupies its own line --
          exactly the format that the LSP can show in a hover popup.

    Tricky details:
        - The function does not decode HTML entities (e.g. '&amp;');
          the generator's synopses are plain text so this has not been
          an issue in practice, but a future change to the generator
          could surface unescaped entities in the output.
        - Only the first synopsis div on the page is captured; pages
          that legitimately contain multiple are not currently
          encountered but would need the regex to be replaced with
          re.findall.

    Args:
        content: The full HTML page contents as a single string.

    Returns:
        The synopsis text with one usage per line and normalized
        whitespace.  Empty when the page has no synopsis div.
    """
    m = re.search(r'<div class="synopsis">(.*?)</div>', content, re.DOTALL)
    if not m:
        return ""
    raw = m.group(1)
    # Replace <br> and <br/> with newlines
    raw = re.sub(r'<br\s*/?>', '\n', raw)
    # Strip all HTML tags
    raw = re.sub(r'<[^>]+>', '', raw)
    # Clean up lines
    lines = []
    for line in raw.split('\n'):
        line = line.strip()
        if line:
            # Normalize whitespace
            line = re.sub(r'\s+', ' ', line)
            lines.append(line)
    return '\n'.join(lines)


def parse_html_file(filepath):
    """Read, classify, and structure a single command HTML page.

    Loads the file, derives the command name from its basename,
    rejects non-command pages (index, commands, library), and runs the
    CommandHTMLParser over the contents to populate structured fields.
    The synopsis specifically is then overwritten with the regex-based
    extract_synopsis_from_html() result because that path produces
    cleaner '<br>'-separated output than the streaming parser can.

    The returned dict matches the shape that build_commands_json() and
    its callers expect, and is keyed under '_html_name' (the file
    basename without extension) so the merge step can look it up
    without re-deriving the name.

    How it works:
        - File reading is wrapped in try/except so unreadable pages
          return None and the build skips them silently.
        - Pages whose basename matches the non-command allow-list
          ('index', 'commands', 'library') return None up front.
        - The streaming parser may throw on malformed HTML; that is
          also caught and yields None.
        - Description prefers the brief from the NAME section; if the
          brief is empty it falls back to the first three fragments
          of the DESCRIPTION section's '<dd>' bodies joined with
          spaces.

    Tricky details:
        - The 'examples' field is the example_parts list joined with
          newlines; if there were no example fragments, an empty
          string is returned rather than a leading or trailing
          whitespace artifact.
        - parse_html_file does not strip 'handcrafted' suffix from
          basenames -- that is handled later by build_commands_json
          when it iterates over html_data.

    Args:
        filepath: Absolute or relative path to a generated command
            HTML file.

    Returns:
        A dict with keys '_html_name', 'synopsis', 'description',
        'group', 'subcommands', 'options', and 'examples' on success,
        or None when the file cannot be read, is parsed as a non-
        command page, or the HTML parser raises an exception.
    """
    try:
        with open(filepath, "r", encoding="utf-8") as f:
            content = f.read()
    except Exception:
        return None

    # Extract command name from filename
    basename = os.path.basename(filepath).replace(".html", "")
    # Skip non-command pages
    if basename in ("index", "commands", "library"):
        return None

    parser = CommandHTMLParser()
    try:
        parser.feed(content)
    except Exception:
        return None

    # Use regex-based synopsis extraction for reliability
    synopsis = extract_synopsis_from_html(content)
    description = parser.brief or " ".join(parser.description_parts[:3])
    examples = "\n".join(parser.example_parts).strip() if parser.example_parts else ""

    return {
        "_html_name": basename,
        "synopsis": synopsis,
        "description": description,
        "group": parser.group,
        "subcommands": parser.subcommands,
        "options": parser.options,
        "examples": examples,
    }


# ── Markdown Reference Parser ────────────────────────────────────────────────

def parse_command_reference_md(filepath):
    """Slice EAGLE_COMMAND_REFERENCE.md into per-command structured data.

    Reads the markdown reference and splits it on '## name' headings.
    For each section it pulls a brief description (first non-heading
    line), a synopsis (first ''' ```tcl ''' block, less the language
    tag), an examples block (first ''' ```tcl ''' block under
    '### Examples'), and a deduplicated list of option flags
    (backticked tokens starting with a dash).

    Sections whose names match the non-command allow-list ('Table',
    'Additional', 'Copyright') are skipped so introductory chapters do
    not contaminate the command map.  The result is a dict keyed by
    command name with one sub-dict per command, ready to merge with
    the HTML and TOC data sources in build_commands_json().

    How it works:
        - re.split on the '## word' heading regex yields the standard
          alternating list and the loop strides through it in pairs.
        - The brief is the first non-empty line of the body that is
          not itself a heading ('#').  Trailing periods are stripped
          to harmonize with the HTML brief style.
        - Synopses and examples are extracted with re.search using
          DOTALL to span newlines.
        - Options are gathered with re.findall against backticked
          dash-led tokens, then deduplicated while preserving order
          via dict.fromkeys (a stable-order set).

    Tricky details:
        - The '## (\\w+)' heading regex requires the name to be ASCII
          word characters; section headings with spaces or punctuation
          are silently skipped.
        - Brief description strips a single trailing period; multiple
          trailing punctuation marks would be preserved.
        - Backtick option discovery is body-wide, so an option name
          mentioned in prose is still captured even if it is not
          listed in a dedicated options block.

    Args:
        filepath: Absolute path to EAGLE_COMMAND_REFERENCE.md.

    Returns:
        A dict mapping command name to a sub-dict with keys
        'description', 'synopsis', 'examples', and 'options'.  Each
        value is a possibly empty string except 'options' which is a
        possibly empty list.
    """
    with open(filepath, "r", encoding="utf-8") as f:
        content = f.read()

    commands = {}
    # Split on ## command_name headings
    sections = re.split(r"^## (\w+)\s*$", content, flags=re.MULTILINE)
    # sections[0] is preamble, then alternating name, body
    i = 1
    while i < len(sections) - 1:
        cmd_name = sections[i].strip()
        cmd_body = sections[i + 1]
        i += 2

        if cmd_name in ("Table", "Additional", "Copyright"):
            continue

        # Extract brief from TOC or first line
        brief = ""
        first_line = cmd_body.strip().split("\n")[0]
        if first_line and not first_line.startswith("#"):
            brief = first_line.strip().rstrip(".")

        # Extract synopsis
        synopsis = ""
        syn_match = re.search(r"```tcl\n(.*?)```", cmd_body, re.DOTALL)
        if syn_match:
            synopsis = syn_match.group(1).strip()

        # Extract examples
        examples = ""
        # Find example section
        ex_match = re.search(r"### Examples\s*```tcl\n(.*?)```", cmd_body, re.DOTALL)
        if ex_match:
            examples = ex_match.group(1).strip()

        # Extract options from body
        md_options = re.findall(r"`(-\w[\w-]*)`", cmd_body)
        md_options = list(dict.fromkeys(md_options))  # dedupe preserving order

        commands[cmd_name] = {
            "description": brief,
            "synopsis": synopsis,
            "examples": examples,
            "options": md_options,
        }

    return commands


# ── Merge Everything ─────────────────────────────────────────────────────────

def build_commands_json():
    """Produce the merged eagle_commands.json payload.

    Combines four sources of truth about every Eagle command into a
    single sorted list of dicts that the LSP server will load at
    startup: the authoritative commands.json (extracted from the
    Eagle source tree), the generated per-command HTML pages, the
    EAGLE_COMMAND_REFERENCE.md narrative reference, and the table-of-
    contents brief blurbs from that same markdown file.

    The output is a list of dicts each shaped:

        {
            'name': str,            # canonical command name
            'group': str,           # group classification
            'synopsis': str,        # one usage per line
            'description': str,     # brief description
            'subcommands': [str],   # subcommand names
            'options': [str],       # option flag names
            'examples': str,        # example Tcl snippet
        }

    How it works:
        1. Load base_commands from commands.json.  This is the
           ground-truth list of commands and their option/subcommand
           inventories.
        2. Parse every '*.html' file in DOCS_DIR through parse_html_file
           and key the results by basename via '_html_name'.
        3. Parse the markdown reference if present.
        4. Walk the markdown reference a second time to collect the TOC
           briefs (two slightly different bullet shapes are accepted).
        5. For every command in base_commands, merge the four sources
           with documented precedence rules (see the inline comments)
           into one output entry.
        6. For commands found in HTML but not in base_commands, append
           an entry built purely from HTML and markdown sources so the
           LSP at least has hover content for them.  'handcrafted'
           variants are skipped to avoid duplicates of the canonical
           page.
        7. Sort by name so the resulting JSON is diff-friendly.

    Merge precedence (per field):
        - synopsis: HTML > base-derived (cleaned usages) > markdown
        - description: markdown brief > HTML brief > TOC blurb
        - subcommands: base entries first, augmented by any HTML
          entries not already present
        - options: base entries first, augmented by HTML then markdown
          entries that are not already present
        - examples: markdown > HTML
        - group: base > HTML

    Tricky details:
        - When HTML data for the canonical name is absent the code
          performs a startswith-based fallback ('namespace1' could be
          satisfied by 'namespace.html' for example), explicitly
          excluding 'handcrafted' suffixed files.
        - Base usages are cleaned by stripping trailing backslashes,
          rejecting placeholders like '{0}', and deduplicating while
          preserving order.
        - The function mutates final_subs and final_opts in place
          while augmenting from secondary sources; this is intentional
          because each iteration also rebuilds final_subs/final_opts
          from the base list at the start of the loop.

    Returns:
        A list of merged command dicts sorted alphabetically by name.
    """
    # 1. Load base structure from commands.json
    with open(os.path.join(DOCS_DIR, "commands.json"), "r") as f:
        base_commands = json.load(f)

    # 2. Parse HTML files
    html_data = {}
    for fname in os.listdir(DOCS_DIR):
        if not fname.endswith(".html"):
            continue
        result = parse_html_file(os.path.join(DOCS_DIR, fname))
        if result:
            html_data[result["_html_name"]] = result

    # 3. Parse markdown reference
    md_ref_path = os.path.join(DOCS_DIR, "EAGLE_COMMAND_REFERENCE.md")
    md_data = {}
    if os.path.exists(md_ref_path):
        md_data = parse_command_reference_md(md_ref_path)

    # 4. Parse the TOC from markdown for brief descriptions of ALL commands
    toc_briefs = {}
    with open(md_ref_path, "r") as f:
        for line in f:
            m = re.match(r"^- \[\*\*(\w+)\*\*\].*? - (.+)$", line.strip())
            if not m:
                m = re.match(r"^- \*\*(\w+)\*\* - (.+)$", line.strip())
            if m:
                toc_briefs[m.group(1)] = m.group(2).strip()

    # 5. Build merged list
    output = []
    seen_names = set()

    for cmd in base_commands:
        name = cmd["command_name"]
        seen_names.add(name)

        # Clean usages - remove backslash-continued duplicates and format strings
        usages = []
        for u in cmd.get("usages", []):
            u = u.rstrip("\\")
            if u and u not in usages and "{0}" not in u:
                usages.append(u)
        synopsis = "\n".join(usages)

        # Get HTML data
        # Try exact name, then name variants (namespace1 -> namespace)
        h = html_data.get(name, {})
        if not h:
            # Try finding an HTML file that starts with the command name
            for hname, hdata in html_data.items():
                if hname.startswith(name) and "handcrafted" not in hname:
                    h = hdata
                    break

        # Get markdown data
        md = md_data.get(name, {})

        # Merge synopsis: prefer HTML (more complete from source), fall back to base
        final_synopsis = h.get("synopsis", "") or synopsis or md.get("synopsis", "")

        # Merge description: prefer md brief, then html, then toc
        final_desc = md.get("description", "") or h.get("description", "") or toc_briefs.get(name, "")

        # Merge subcommands: prefer base (from source), augment with HTML
        final_subs = cmd.get("subcommands", [])
        html_subs = h.get("subcommands", [])
        if html_subs and not final_subs:
            final_subs = html_subs
        elif html_subs:
            # Merge unique
            s = set(final_subs)
            for sub in html_subs:
                if sub not in s:
                    final_subs.append(sub)
                    s.add(sub)

        # Merge options
        final_opts = cmd.get("options", [])
        html_opts = h.get("options", [])
        md_opts = md.get("options", [])
        opts_set = set(final_opts)
        for o in html_opts + md_opts:
            if o not in opts_set:
                final_opts.append(o)
                opts_set.add(o)

        # Examples from md or html
        final_examples = md.get("examples", "") or h.get("examples", "")

        # Group
        final_group = cmd.get("group", "") or h.get("group", "")

        output.append({
            "name": name,
            "group": final_group,
            "synopsis": final_synopsis,
            "description": final_desc,
            "subcommands": final_subs,
            "options": final_opts,
            "examples": final_examples,
        })

    # 6. Add commands found in HTML but not in commands.json
    for hname, hdata in html_data.items():
        # Skip handcrafted duplicates and non-command pages
        if "handcrafted" in hname:
            continue
        # Normalize: namespace1 -> namespace1 (keep as-is, they're separate pages)
        if hname not in seen_names:
            md = md_data.get(hname, {})
            final_desc = md.get("description", "") or hdata.get("description", "") or toc_briefs.get(hname, "")
            output.append({
                "name": hname,
                "group": hdata.get("group", ""),
                "synopsis": hdata.get("synopsis", "") or md.get("synopsis", ""),
                "description": final_desc,
                "subcommands": hdata.get("subcommands", []),
                "options": hdata.get("options", []),
                "examples": md.get("examples", "") or hdata.get("examples", ""),
            })
            seen_names.add(hname)

    # Sort by name
    output.sort(key=lambda x: x["name"])
    return output


# ── Procedures Parser ────────────────────────────────────────────────────────

def build_procedures_json():
    """Produce the merged eagle_procedures.json payload.

    Walks core_script_library.md to build a sorted list of dicts, one
    per Eagle script library procedure, that the LSP can use for
    completion and hover details.  The markdown is laid out as '####
    procName' sub-section headings for each procedure plus an
    alphabetical index table at the top of the file; both layouts are
    consumed and merged so that a procedure that appears only in the
    index still shows up in the output (with a stub signature).

    The output is a list of dicts each shaped:

        {
            'name': str,            # procedure name
            'signature': str,       # Tcl-style call signature
            'description': str,     # brief description
            'source_file': str,     # owning library file from index
            'args': [{'name','description'}],
            'returns': str,         # return-value description
            'example': str,         # example Tcl snippet
        }

    How it works:
        1. Pre-pass: collect the alphabetical index briefs and the
           source-file column into index_briefs / index_sources.
        2. Main pass: re.split on '#### name' headings (optionally
           with a parenthesized qualifier like '(Eagle only)') and
           stride pairs.
        3. For each procedure section, extract:
             - signature from the first ```tcl block,
             - description from the first paragraph after the
               signature block, falling back to the index brief,
             - args from the bullets under a '**Arguments**' label,
             - returns from a '**Returns**:' label,
             - example from an explicit '- **Example**:' block or the
               second ```tcl block on the page if there is one.
        4. Deduplicate: when the same procedure name appears more
           than once (some procs are documented in multiple chapters
           like isEagle), merge the longer/richer fields into the
           existing entry rather than appending a duplicate.
        5. Append index-only procedures (present in the alpha table
           but missing a '####' section) as stubs with synthesized
           'name args' signatures so the LSP at least knows the name
           exists.
        6. Sort by name for diff-friendly output.

    Tricky details:
        - The example extraction explicitly rejects a ```tcl block
          whose content matches the signature, because some
          procedures only have a signature block and no real example.
          When that happens the function looks for a SECOND ```tcl
          block; if none exists, example stays empty.
        - 'returns' captures only the first line following the
          '**Returns**:' label; trailing periods are stripped so the
          field reads naturally inside hover-popup sentences.
        - The 'i = i' line inside the dedup branch is a no-op left
          over from earlier development; the 'continue' immediately
          below it is what actually advances the loop.

    Returns:
        A list of merged procedure dicts sorted alphabetically by
        name.
    """
    filepath = os.path.join(REPO_DIR, "core_script_library.md")
    with open(filepath, "r", encoding="utf-8") as f:
        content = f.read()

    procedures = []

    # Also extract from the alphabetical index table for brief descriptions
    index_briefs = {}
    index_sources = {}
    for m in re.finditer(
        r"\| `(\w+)` \| ([\w.]+) \| (.+?) \|", content
    ):
        index_briefs[m.group(1)] = m.group(3).strip()
        index_sources[m.group(1)] = m.group(2).strip()

    # Split into procedure sections using #### headings
    # Pattern: #### procName or #### procName (Eagle only) etc.
    # Only match valid Tcl identifiers (letters, digits, underscores, colons)
    parts = re.split(r"^#### (\w+)(?: \(.*?\))?\s*$", content, flags=re.MULTILINE)
    # parts[0] = before first ####, then alternating name, body

    seen = set()
    i = 1
    while i < len(parts) - 1:
        proc_name = parts[i].strip()
        proc_body = parts[i + 1]
        i += 2

        # Extract signature from ```tcl block
        sig_match = re.search(r"```tcl\n(.*?)```", proc_body, re.DOTALL)
        signature = ""
        if sig_match:
            signature = sig_match.group(1).strip()

        # Extract description: first paragraph after the code block
        desc = ""
        desc_match = re.search(r"```\n\n(.+?)\n\n", proc_body, re.DOTALL)
        if desc_match:
            desc = desc_match.group(1).strip()
            # Clean up markdown
            desc = re.sub(r"\*\*(.+?)\*\*", r"\1", desc)  # bold
            desc = re.sub(r"`(.+?)`", r"\1", desc)  # code
            desc = desc.replace("\n", " ")
        if not desc:
            desc = index_briefs.get(proc_name, "")

        # Extract arguments - only from the Arguments section, not the whole body
        args_list = []
        args_section = re.search(r"\*\*Arguments\*\*:?\s*\n((?:\s+- .+\n)*)", proc_body)
        if args_section:
            for am in re.finditer(r"^\s+- `(\w+)` - (.+)$", args_section.group(1), re.MULTILINE):
                args_list.append({"name": am.group(1), "description": am.group(2).strip()})

        # Extract return value
        returns = ""
        ret_match = re.search(r"\*\*Returns\*\*:\s*(.+?)(?:\n|$)", proc_body)
        if ret_match:
            returns = ret_match.group(1).strip().rstrip(".")

        # Extract example
        example = ""
        ex_match = re.search(r"- \*\*Example\*\*:\s*```tcl\n(.*?)```", proc_body, re.DOTALL)
        if not ex_match:
            ex_match = re.search(r"```tcl\n(.*?)```", proc_body, re.DOTALL)
            # Only use if it looks like example (not the signature)
            if ex_match and ex_match.group(1).strip() == signature:
                ex_match = None
            # Check for second code block
            all_blocks = re.findall(r"```tcl\n(.*?)```", proc_body, re.DOTALL)
            if len(all_blocks) > 1:
                example = all_blocks[-1].strip()
        if ex_match and not example:
            example = ex_match.group(1).strip()
        # Don't use signature as example
        if example == signature:
            example = ""

        source_file = index_sources.get(proc_name, "")

        # Deduplicate (some procs appear in multiple sections like isEagle)
        key = proc_name
        if key in seen:
            # Keep the one with more info
            for existing in procedures:
                if existing["name"] == proc_name:
                    if len(signature) > len(existing.get("signature", "")):
                        existing["signature"] = signature
                    if len(desc) > len(existing.get("description", "")):
                        existing["description"] = desc
                    if args_list and not existing.get("args"):
                        existing["args"] = args_list
                    break
            i = i  # continue
            continue
        seen.add(key)

        procedures.append({
            "name": proc_name,
            "signature": signature,
            "description": desc,
            "source_file": source_file,
            "args": args_list,
            "returns": returns,
            "example": example,
        })

    # Add any from the index table not found in #### sections
    for pname, brief in index_briefs.items():
        if pname not in seen:
            procedures.append({
                "name": pname,
                "signature": f"{pname} args",
                "description": brief,
                "source_file": index_sources.get(pname, ""),
                "args": [],
                "returns": "",
                "example": "",
            })

    procedures.sort(key=lambda x: x["name"])
    return procedures


# ── Main ─────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    os.makedirs(OUT_DIR, exist_ok=True)

    print("Extracting commands...")
    commands = build_commands_json()
    cmd_path = os.path.join(OUT_DIR, "eagle_commands.json")
    with open(cmd_path, "w") as f:
        json.dump(commands, f, indent=2)
    print(f"  Wrote {len(commands)} commands to {cmd_path}")

    # Stats
    with_desc = sum(1 for c in commands if c["description"])
    with_syn = sum(1 for c in commands if c["synopsis"])
    with_subs = sum(1 for c in commands if c["subcommands"])
    with_opts = sum(1 for c in commands if c["options"])
    with_ex = sum(1 for c in commands if c["examples"])
    print(f"  With description: {with_desc}, synopsis: {with_syn}, subcommands: {with_subs}, options: {with_opts}, examples: {with_ex}")

    print("\nExtracting procedures...")
    procs = build_procedures_json()
    proc_path = os.path.join(OUT_DIR, "eagle_procedures.json")
    with open(proc_path, "w") as f:
        json.dump(procs, f, indent=2)
    print(f"  Wrote {len(procs)} procedures to {proc_path}")

    with_sig = sum(1 for p in procs if p["signature"])
    with_desc = sum(1 for p in procs if p["description"])
    with_args = sum(1 for p in procs if p["args"])
    print(f"  With signature: {with_sig}, description: {with_desc}, args: {with_args}")

    print("\nDone!")
