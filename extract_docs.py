#!/usr/bin/env python3
"""Extract Eagle command documentation into structured JSON for the LSP server."""
import json, re, os
from html.parser import HTMLParser

# --- Source and output locations --------------------------------------------
#
# Default to the conventional sibling-checkout layout (the "docs" and "lsp"
# repositories next to each other); override any of them with an environment
# variable.  See PIPELINE.md for the full source-of-truth chain.
#
#   DOCS_REPO   the Eagle documentation repository (Markdown source) -- the
#               sibling "docs" checkout; provides "core_language.md" and
#               "core_script_library.md".
#   DOCS_BUILD  the *generated* documentation tree: the structured command
#               inventory "commands.json", the per-command "*.html" pages, and
#               "EAGLE_COMMAND_REFERENCE.md" (a build artifact, not the Markdown
#               source repo -- supply via EAGLE_DOCS_BUILD).
#   OUT_DIR     this LSP repository's "data" directory (the generated JSON).
#
_LSP_ROOT = os.path.dirname(os.path.abspath(__file__))

DOCS_REPO = os.environ.get(
    'EAGLE_DOCS', os.path.join(_LSP_ROOT, os.pardir, 'docs'))
DOCS_BUILD = os.environ.get(
    'EAGLE_DOCS_BUILD', os.path.join(DOCS_REPO, 'build', 'docs'))
OUT_DIR = os.environ.get('EAGLE_LSP_DATA', os.path.join(_LSP_ROOT, 'data'))

# --- 1. Load base commands.json (the structured command inventory) ---
with open(os.path.join(DOCS_BUILD, 'commands.json')) as f:
    base_commands = json.load(f)

# --- 2. Parse EAGLE_COMMAND_REFERENCE.md for descriptions/examples ---
with open(os.path.join(DOCS_BUILD, 'EAGLE_COMMAND_REFERENCE.md')) as f:
    md_content = f.read()

def extract_md_sections(content):
    """Parse EAGLE_COMMAND_REFERENCE.md into a dict of per-command sections.

    Walks the markdown reference and chunks it on level-2 headings (lines
    that begin with '## ' followed by an all-lowercase identifier).  Each
    chunk corresponds to one Eagle command, and the function pulls three
    fields out of the chunk body: a one-paragraph description, a synopsis
    code block, and an examples code block.  These are the building blocks
    that the LSP uses for hover popups and completion-item details, so
    only loosely structured fields are needed -- one short paragraph and
    two pre-formatted Tcl snippets.

    How it works:
        - re.split on the heading regex returns an alternating list:
          [preamble, name1, body1, name2, body2, ...].  The loop strides
          through it in pairs starting at index 1, stopping one short of
          the end to keep name/body always paired.
        - The description is the first paragraph after the heading, with
          any sub-headings ('### ...') skipped over.  Embedded newlines
          are collapsed so the result is a single line suitable for hover
          tooltips.
        - Synopsis and examples are extracted from the first fenced code
          block following the '### Synopsis' or '### Examples' (or
          '### Example') heading.  The optional 'tcl' language tag is
          tolerated.

    Tricky details:
        - The heading regex requires the command name to be lowercase
          ASCII (letters, digits, underscores) starting with a letter.
          Sections that do not match this shape (table of contents,
          appendices, etc.) are silently ignored.
        - When the description regex does not match (for example a
          command whose body begins immediately with a sub-heading), the
          description stays empty -- consumers should treat missing keys
          as 'no information'.
        - Only the FIRST code block under Synopsis and Examples is
          captured; commands with multiple examples will have everything
          past the first ''' collapsed into one block.

    Args:
        content: The full text of EAGLE_COMMAND_REFERENCE.md as a single
            string with embedded newlines.

    Returns:
        A dict mapping the command name to a sub-dict with keys
        'description', 'synopsis', and 'examples'.  Each value is a
        possibly empty string.  Commands present in the file but lacking
        any of the three fields will still appear in the dict with empty
        strings for the missing values.
    """
    sections = {}
    # Split on ## headings (level 2) that are command names
    parts = re.split(r'^## ([a-z][a-z0-9_]*)\s*$', content, flags=re.MULTILINE)
    for i in range(1, len(parts)-1, 2):
        cmd_name = parts[i].strip()
        section_text = parts[i+1]
        # Extract description (first paragraph after heading)
        desc_match = re.search(r'^(?:###.*?\n)*\n*(.+?)(?:\n\n|\n###)', section_text, re.DOTALL)
        description = ''
        if desc_match:
            description = desc_match.group(1).strip()
            description = re.sub(r'\n', ' ', description)
            description = re.sub(r'\s+', ' ', description)
        
        # Extract synopsis from code blocks after ### Synopsis
        synopsis_match = re.search(r'### Synopsis\s*```(?:tcl)?\s*(.+?)```', section_text, re.DOTALL)
        synopsis = ''
        if synopsis_match:
            synopsis = synopsis_match.group(1).strip()
        
        # Extract examples
        examples_match = re.search(r'### Examples?\s*```(?:tcl)?\s*(.+?)```', section_text, re.DOTALL)
        examples = ''
        if examples_match:
            examples = examples_match.group(1).strip()
        
        sections[cmd_name] = {
            'description': description,
            'synopsis': synopsis,
            'examples': examples
        }
    return sections

md_sections = extract_md_sections(md_content)

# --- 3. Parse HTML files for additional descriptions ---
class TextExtractor(HTMLParser):
    """Strip an HTML document down to its visible text content.

    Specializes html.parser.HTMLParser to walk an HTML document and
    accumulate the human readable text while skipping the contents of
    'script' and 'style' elements.  The result is used as a fallback
    description source for commands that lack a markdown or core_language
    entry, so a noisy but mostly correct rendering is good enough; full
    layout fidelity is not required.

    Attributes:
        text: A list of text fragments collected during parsing, in the
            order they were encountered.  Consumers should call
            get_text() to join them into a single space-separated string
            rather than reading this list directly.
        skip: A bool that is True while the parser is inside a 'script'
            or 'style' element.  Used to suppress data callbacks for
            those elements without losing track of nesting.
    """
    def __init__(self):
        """Initialize the parser with empty state.

        Calls the base HTMLParser constructor and sets up the fragment
        accumulator and the skip flag.  Created fresh for each HTML
        document so that fragments from prior files do not leak into the
        current one.
        """
        super().__init__()
        self.text = []
        self.skip = False
    def handle_starttag(self, tag, attrs):
        """Enter skip mode whenever a 'script' or 'style' element opens.

        Called by the base HTMLParser for each opening tag in the input.
        Only 'script' and 'style' are special-cased because their text
        content is never visible to the reader (they hold code and
        formatting rules) and would pollute the extracted description.

        Args:
            tag: Lower-cased element name reported by the base parser.
            attrs: List of (name, value) attribute pairs.  Unused here.
        """
        if tag in ('script', 'style'):
            self.skip = True
    def handle_endtag(self, tag):
        """Leave skip mode when the matching 'script' or 'style' closes.

        Mirrors handle_starttag.  Note that no nesting depth is tracked:
        because 'script' and 'style' cannot legally contain another
        'script' or 'style', a simple boolean flag is sufficient.

        Args:
            tag: Lower-cased element name reported by the base parser.
        """
        if tag in ('script', 'style'):
            self.skip = False
    def handle_data(self, data):
        """Capture a text fragment unless we are inside script/style.

        Called by the base HTMLParser for each text run between tags.
        The check against the skip flag is what excludes invisible
        scripts and styles from the extracted output.

        Args:
            data: The raw text fragment as a string.  Stored verbatim;
                whitespace normalization is deferred until get_text() is
                joined and the caller post-processes the result.
        """
        if not self.skip:
            self.text.append(data)
    def get_text(self):
        """Return all captured fragments joined with single spaces.

        Joining with a space (rather than ''.join) ensures that
        adjacent fragments from sibling elements do not run together
        into a single word; the caller normally collapses runs of
        whitespace afterwards.

        Returns:
            A single string containing every collected fragment in order,
            separated by single spaces.  Empty when nothing was captured.
        """
        return ' '.join(self.text)

def extract_html_description(filepath):
    """Mine a short description out of an HTML command-reference file.

    Reads the file at filepath, strips it to plain text with
    TextExtractor, and returns the first 'meaningful' sentence -- a
    sentence at least 21 characters long that does not start with the
    word 'Eagle' (which would typically be a generic intro like 'Eagle
    is a ...') and does not contain the substring 'navigation' (which
    catches site-chrome breadcrumbs).  When nothing matches the
    heuristic the first 300 characters of the cleaned text are returned
    as a fallback.

    This function is the lowest-priority description source for the
    merge step: HTML descriptions are used only when neither the
    markdown reference nor core_language.md has anything for a command,
    because HTML pages mix navigation, code samples, and free prose in
    ways that the heuristic only roughly untangles.

    How it works:
        - File contents are read; any exception (missing file, encoding
          error, parser failure) is swallowed and the empty string is
          returned so that one broken HTML page never aborts the build.
        - Text is collected through TextExtractor and runs of
          whitespace are collapsed to single spaces.
        - The text is split on sentence-ending punctuation followed by
          whitespace.  The first sentence longer than 20 characters
          that survives the 'Eagle'/'navigation' filters is truncated
          to 300 characters and returned.

    Tricky details:
        - The bare 'except:' is deliberate.  This is a build script and
          any failure on a single page should yield an empty
          description rather than aborting the whole extraction.
        - Truncation is a hard slice to 300 characters; it may cut
          mid-word.  The LSP server displays this as a tooltip where a
          truncated tail is acceptable.

    Args:
        filepath: Absolute or relative path to the HTML file to mine.

    Returns:
        The first acceptable sentence (truncated to 300 chars) or the
        first 300 characters of the cleaned text when no sentence
        passes the heuristic.  The empty string is returned for any
        I/O or parsing failure.
    """
    try:
        with open(filepath) as f:
            content = f.read()
        parser = TextExtractor()
        parser.feed(content)
        text = parser.get_text()
        # Clean up
        text = re.sub(r'\s+', ' ', text).strip()
        # Get first meaningful sentence
        sentences = re.split(r'(?<=[.!?])\s+', text)
        for s in sentences:
            s = s.strip()
            if len(s) > 20 and not s.startswith('Eagle') and 'navigation' not in s.lower():
                return s[:300]
        return text[:300] if text else ''
    except:
        return ''

html_descriptions = {}
for fname in os.listdir(DOCS_BUILD):
    if fname.endswith('.html') and fname not in ('index.html', 'commands.html'):
        cmd_name = fname.replace('.html', '').replace('_handcrafted', '')
        # Skip numbered variants
        if cmd_name[-1].isdigit() and cmd_name[:-1] in html_descriptions:
            continue
        desc = extract_html_description(os.path.join(DOCS_BUILD, fname))
        if desc:
            html_descriptions[cmd_name] = desc

# --- 4. Parse core_language.md for detailed command info ---
with open(os.path.join(DOCS_REPO, 'core_language.md')) as f:
    core_lang = f.read()

def extract_core_lang_descriptions(content):
    """Pull brief descriptions and example usages from core_language.md.

    Scans the markdown for anchored command entries of the form:

        <a id="cmd-NAME"></a>
        - **NAME** - description text spanning until the next bullet,
          another anchored entry, or a horizontal rule

    For each match, the first line of the body is treated as the brief
    description and any backtick-quoted code fragments inside the body
    that look like a usage pattern for this exact command are collected
    as 'usages'.  Both pieces of information feed the LSP's
    completion-item details and hover popups.

    How it works:
        - re.finditer walks every anchor/heading pair in the document.
          The DOTALL flag lets the body span newlines, and the
          terminator pattern matches the start of the next bullet, the
          next bold-wrapped name, or a horizontal rule.
        - The first line of the body is the brief.  Subsequent lines
          (and any backtick code inside them) provide candidate usage
          examples.
        - Each backtick fragment is kept only if its first whitespace-
          separated token contains the command name and the fragment is
          longer than the bare command name -- a coarse but effective
          filter that keeps 'cmd subcommand arg' patterns while
          rejecting bare cross references like '`cmd`'.

    Tricky details:
        - The usage filter uses the expression
          `cmd_name in u.split()[0]`, which is substring-matching
          against the first token; this can produce false positives
          when one command's name is a prefix of another.  The 5-item
          cap limits the damage when this happens.
        - The terminator regex is intentionally loose; if a command's
          body does not end with one of the recognized markers, the
          regex will keep matching until the next anchor or the end of
          the document.

    Args:
        content: The full text of core_language.md as a single string.

    Returns:
        A dict keyed by command name with sub-dicts of the form
        {'brief': str, 'usages': [str]} where usages contains at most
        five short Tcl-flavored usage strings.
    """
    descs = {}
    # Find patterns like <a id="cmd-NAME"></a>\n- **NAME** - Description
    matches = re.finditer(
        r'<a id="cmd-([^"]+)"></a>\s*\n-\s*\*\*([^*]+)\*\*\s*-\s*(.+?)(?:\n\s*-\s*`|\n\s*-\s*\*\*|\n---)', 
        content, re.DOTALL
    )
    for m in matches:
        cmd_name = m.group(1)
        desc_block = m.group(3).strip()
        # Get first line as brief, rest as detail
        lines = desc_block.split('\n')
        brief = lines[0].strip()
        # Extract usages from the block
        usages = re.findall(r'`([^`]+)`', desc_block)
        usages = [u for u in usages if cmd_name in u.split()[0] if len(u) > len(cmd_name)+1]
        descs[cmd_name] = {
            'brief': brief,
            'usages': usages[:5]  # limit
        }
    return descs

core_descs = extract_core_lang_descriptions(core_lang)

# --- 5. Merge everything ---
commands = []
for cmd in base_commands:
    name = cmd['command_name']
    
    # Clean usages (remove trailing backslash variants)
    usages = [u for u in cmd.get('usages', []) if not u.endswith('\\')]
    # Deduplicate
    seen = set()
    clean_usages = []
    for u in usages:
        if u not in seen:
            seen.add(u)
            clean_usages.append(u)
    
    # Build description from multiple sources
    description = ''
    if name in md_sections and md_sections[name]['description']:
        description = md_sections[name]['description']
    elif name in core_descs:
        description = core_descs[name]['brief']
    elif name in html_descriptions:
        description = html_descriptions[name]
    
    # Synopsis
    synopsis = ''
    if name in md_sections and md_sections[name]['synopsis']:
        synopsis = md_sections[name]['synopsis']
    elif clean_usages:
        synopsis = '\n'.join(clean_usages)
    
    # Examples
    examples = ''
    if name in md_sections:
        examples = md_sections[name].get('examples', '')
    
    entry = {
        'name': name,
        'group': cmd.get('group', 'misc'),
        'synopsis': synopsis,
        'description': description,
        'subcommands': cmd.get('subcommands', []),
        'options': cmd.get('options', []),
        'usages': clean_usages,
        'examples': examples,
        'flags': cmd.get('flags', [])
    }
    commands.append(entry)

with open(os.path.join(OUT_DIR, 'eagle_commands.json'), 'w') as f:
    json.dump(commands, f, indent=2)

print(f'Extracted {len(commands)} commands')

# --- 6. Extract procedures from core_script_library.md ---
with open(os.path.join(DOCS_REPO, 'core_script_library.md')) as f:
    lib_content = f.read()

procedures = []
# Find #### procedureName patterns
proc_blocks = re.split(r'^#### ([a-zA-Z_][a-zA-Z0-9_]*)\s*$', lib_content, flags=re.MULTILINE)
for i in range(1, len(proc_blocks)-1, 2):
    proc_name = proc_blocks[i].strip()
    block = proc_blocks[i+1]
    
    # Get signature from backtick code
    sig_match = re.search(r'`([^`]*' + re.escape(proc_name) + r'[^`]*)`', block)
    signature = sig_match.group(1) if sig_match else proc_name
    
    # Get description (first paragraph)
    desc_match = re.search(r'^\s*(.+?)(?:\n\n|\n-|\n\*|\n`)', block, re.DOTALL)
    desc = ''
    if desc_match:
        desc = desc_match.group(1).strip()
        desc = re.sub(r'\n', ' ', desc)
        desc = re.sub(r'\s+', ' ', desc)
    
    # Get package/source info from surrounding context
    procedures.append({
        'name': proc_name,
        'signature': signature,
        'description': desc[:500]
    })

with open(os.path.join(OUT_DIR, 'eagle_procedures.json'), 'w') as f:
    json.dump(procedures, f, indent=2)

print(f'Extracted {len(procedures)} procedures')
