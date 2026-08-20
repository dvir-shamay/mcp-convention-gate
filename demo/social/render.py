#!/usr/bin/env python3
"""Render the polished hero GIF(s): agg (themed terminal) -> ffmpeg composite onto
the palette frame template, with a timed lower-third caption that switches per beat.

Drives agg/ffmpeg via subprocess arg-lists (no shell), so filter strings with quotes
and commas are passed verbatim -- avoiding the PowerShell quoting issues.

Usage:  python demo/social/render.py [catppuccin|tokyonight|rosepine|all]
"""
import glob, json, os, shutil, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
CAST = os.path.join(HERE, 'hero.cast')
MANIFEST = os.path.join(HERE, 'hero.manifest.json')
LABEL = 'Inter-Bold.ttf'  # Inter Bold (SIL OFL, redistributable); relative so ffmpeg drawtext avoids the drive-colon


def find_tool(name):
    """Resolve a winget-installed exe regardless of whether PATH is refreshed."""
    p = shutil.which(name)
    if p:
        return p
    base = os.path.join(os.environ['LOCALAPPDATA'], 'Microsoft', 'WinGet', 'Packages')
    hits = glob.glob(os.path.join(base, '**', name + '.exe'), recursive=True)
    if not hits:
        raise FileNotFoundError(f'{name} not found on PATH or under WinGet Packages')
    return hits[0]


AGG = find_tool('agg')
FFMPEG = find_tool('ffmpeg')

PAL = {
    'catppuccin': dict(
        theme="1e1e2e,cdd6f4,45475a,f38ba8,a6e3a1,f9e2af,89b4fa,f5c2e7,94e2d5,bac2de,585b70,f38ba8,a6e3a1,f9e2af,89b4fa,f5c2e7,94e2d5,a6adc8",
        capfg="0xcdd6f4", pass_="0xa6e3a1"),
    'tokyonight': dict(
        theme="1a1b26,c0caf5,15161e,f7768e,9ece6a,e0af68,7aa2f7,bb9af7,7dcfff,a9b1d6,414868,f7768e,9ece6a,e0af68,7aa2f7,bb9af7,7dcfff,c0caf5",
        capfg="0xc0caf5", pass_="0x9ece6a"),
    'rosepine': dict(
        theme="191724,e0def4,26233a,eb6f92,31748f,f6c177,9ccfd8,c4a7e7,ebbcba,e0def4,6e6a86,eb6f92,31748f,f6c177,9ccfd8,c4a7e7,ebbcba,e0def4",
        capfg="0xe0def4", pass_="0x9ccfd8"),
}

CAPS = [
    "Text alone does not stop the commit",
    "The agent registers the review over MCP",
    "Gate satisfied - commit allowed",
]

# Output canvas per social format (width, height).
FORMATS = {
    'x':      (1600, 900),   # X / Twitter 16:9
    'li-1x1': (1200, 1200),  # LinkedIn square
    'li-4x5': (1080, 1350),  # LinkedIn portrait
}


def geometry(palette, W, H):
    tpl = os.path.join(HERE, f'_tpl-{palette}-{W}x{H}.png')
    out = subprocess.run([sys.executable, os.path.join(HERE, 'template.py'),
                          '--palette', palette, '--tw', '871', '--th', '593',
                          '--width', str(W), '--height', str(H), '--out', tpl],
                         capture_output=True, text=True, check=True)
    return tpl, json.loads(out.stdout)


def render(palette, fmt='x', cast_base='hero'):
    p = PAL[palette]
    W, H = FORMATS[fmt]
    suffix = '' if fmt == 'x' else '-' + fmt
    cast = os.path.join(HERE, cast_base + '.cast')
    manifest = json.load(open(os.path.join(HERE, cast_base + '.manifest.json')))
    beats = manifest['beats']
    dur = manifest['duration']  # intended full length incl. the closing success hold
    b1, b2 = beats[1]['start'], beats[2]['start']  # caption switch points
    tpl, g = geometry(palette, W, H)
    capy = g['cap_y'] + 30

    term = os.path.join(HERE, f'_term-{palette}.gif')
    subprocess.run([AGG, '--font-family', 'Consolas', '--font-size', '24', '--line-height', '1.3',
                    '--theme', p['theme'], cast, term], check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)

    def dt(text, color, t0, t1):
        return (f"drawtext=fontfile={LABEL}:text='{text}':x=(w-text_w)/2:y={capy}:"
                f"fontsize=44:fontcolor={color}:enable='between(t,{t0},{t1})'")

    filt = (
        f"[0:v][1:v]overlay={g['term_x']}:{g['term_y']}[b];"
        f"[b]{dt(CAPS[0], p['capfg'], 0, b1)},"
        f"{dt(CAPS[1], p['capfg'], b1, b2)},"
        f"{dt(CAPS[2], p['pass_'], b2, 60)},"
        f"split[x][y];[x]palettegen=stats_mode=diff[p];[y][p]paletteuse[o]"
    )
    out = os.path.join(HERE, f'hero-{palette}{suffix}.gif')
    # -t on the looped template sets the total duration to the manifest's; overlay's
    # default eof_action=repeat holds the term's last (success) frame to fill the tail.
    subprocess.run([FFMPEG, '-y', '-loop', '1', '-t', str(dur), '-i', tpl, '-i', term,
                    '-filter_complex', filt, '-map', '[o]', out], check=True, cwd=HERE,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    kb = round(os.path.getsize(out) / 1024)
    print(f"{g['name']} {fmt} ({W}x{H}) -> {os.path.basename(out)}  ({kb} KB)")


if __name__ == '__main__':
    which = sys.argv[1] if len(sys.argv) > 1 else 'all'
    fmt = sys.argv[2] if len(sys.argv) > 2 else 'x'
    palettes = list(PAL) if which == 'all' else [which]
    fmts = list(FORMATS) if fmt == 'allfmt' else [fmt]
    for name in palettes:
        for f in fmts:
            render(name, f)
