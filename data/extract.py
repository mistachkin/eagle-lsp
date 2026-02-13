#!/usr/bin/env python3
"""Extract Eagle command and procedure data from documentation sources."""

import json
import re
import os
from html.parser import HTMLParser

DOCS_DIR = "/home/exedev/eagle-docs"
REPO_DIR = "/tmp/eagle-docs-repo"
OUT_DIR = "/home/exedev/eagle-lsp/data"

# ── HTML Parser ──────────────────────────────────────────────────────────────

class CommandHTMLParser(HTMLParser):
    """Parse a command HTML file to extract structured fields."""
    def __init__(self):
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
    """Extract synopsis from HTML using regex - more reliable than incremental parsing."""
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
    """Parse one HTML command doc file."""
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
    """Parse EAGLE_COMMAND_REFERENCE.md for descriptions and examples."""
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
    """Extract procedures from core_script_library.md."""
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
