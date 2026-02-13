#!/usr/bin/env python3
"""Extract Eagle command documentation into structured JSON for the LSP server."""
import json, re, os
from html.parser import HTMLParser

# --- 1. Load base commands.json ---
with open('/home/exedev/eagle-docs/commands.json') as f:
    base_commands = json.load(f)

# --- 2. Parse EAGLE_COMMAND_REFERENCE.md for descriptions/examples ---
with open('/home/exedev/eagle-docs/EAGLE_COMMAND_REFERENCE.md') as f:
    md_content = f.read()

def extract_md_sections(content):
    """Extract command sections from the markdown reference."""
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
    def __init__(self):
        super().__init__()
        self.text = []
        self.skip = False
    def handle_starttag(self, tag, attrs):
        if tag in ('script', 'style'):
            self.skip = True
    def handle_endtag(self, tag):
        if tag in ('script', 'style'):
            self.skip = False
    def handle_data(self, data):
        if not self.skip:
            self.text.append(data)
    def get_text(self):
        return ' '.join(self.text)

def extract_html_description(filepath):
    """Get a short description from an HTML doc file."""
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
for fname in os.listdir('/home/exedev/eagle-docs/'):
    if fname.endswith('.html') and fname not in ('index.html', 'commands.html'):
        cmd_name = fname.replace('.html', '').replace('_handcrafted', '')
        # Skip numbered variants  
        if cmd_name[-1].isdigit() and cmd_name[:-1] in html_descriptions:
            continue
        desc = extract_html_description(f'/home/exedev/eagle-docs/{fname}')
        if desc:
            html_descriptions[cmd_name] = desc

# --- 4. Parse core_language.md for detailed command info ---
with open('/tmp/eagle-docs-repo/core_language.md') as f:
    core_lang = f.read()

def extract_core_lang_descriptions(content):
    """Extract descriptions from core_language.md cmd anchors."""
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

with open('/home/exedev/eagle-lsp/data/eagle_commands.json', 'w') as f:
    json.dump(commands, f, indent=2)

print(f'Extracted {len(commands)} commands')

# --- 6. Extract procedures from core_script_library.md ---
with open('/tmp/eagle-docs-repo/core_script_library.md') as f:
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

with open('/home/exedev/eagle-lsp/data/eagle_procedures.json', 'w') as f:
    json.dump(procedures, f, indent=2)

print(f'Extracted {len(procedures)} procedures')
