#!/usr/bin/env python3
"""Build a polished static frame (backdrop + shadow + rounded window + caption pill)
sized around the terminal, in a chosen palette. The animated terminal and the timed
caption text are composited on top later (ffmpeg). Prints the overlay geometry as JSON.

Neutral window chrome (rounded corners, soft shadow, slim title bar, muted dots) — not
tied to any single OS, because the tool itself is cross-platform (pure Node.js + git hook).

Usage:
  python template.py --palette catppuccin --tw 871 --th 593 --out template.png
"""
import argparse, json
from PIL import Image, ImageDraw, ImageFont, ImageFilter


def hx(s):
    s = s.lstrip('#')
    return (int(s[0:2], 16), int(s[2:4], 16), int(s[4:6], 16))


PAL = {
    'catppuccin': dict(bg='#181825', bg2='#1e1e2e', surface='#1e1e2e', titlebar='#181825',
                       border='#313244', titlefg='#7f849c', capfg='#cdd6f4', pill='#313244',
                       ctrl='#9399b2', name='Catppuccin Mocha'),
    'tokyonight': dict(bg='#16161e', bg2='#1a1b26', surface='#1a1b26', titlebar='#16161e',
                       border='#292e42', titlefg='#565f89', capfg='#c0caf5', pill='#24283b',
                       ctrl='#787c99', name='Tokyo Night'),
    'rosepine': dict(bg='#16141f', bg2='#191724', surface='#191724', titlebar='#16141f',
                     border='#26233a', titlefg='#6e6a86', capfg='#e0def4', pill='#1f1d2e',
                     ctrl='#908caa', name='Rose Pine'),
}

PAD, TITLE, GAP, RADIUS = 28, 48, 22, 16


def font(path, size):
    try:
        return ImageFont.truetype(path, size)
    except Exception:
        return ImageFont.load_default()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--palette', required=True, choices=list(PAL))
    ap.add_argument('--tw', type=int, required=True)
    ap.add_argument('--th', type=int, required=True)
    ap.add_argument('--width', type=int, default=1600)
    ap.add_argument('--height', type=int, default=900)
    ap.add_argument('--out', required=True)
    a = ap.parse_args()
    p = PAL[a.palette]
    W, H = a.width, a.height

    win_w = a.tw + 2 * PAD
    win_h = TITLE + GAP + a.th + PAD
    win_x = (W - win_w) // 2
    cap_w, cap_h = min(1080, W - 80), 104
    # vertically center the window + caption block, so any aspect ratio is balanced
    win_y = max(40, (H - (win_h + 28 + cap_h)) // 2)
    term_x = win_x + PAD
    term_y = win_y + TITLE + GAP
    cap_x = (W - cap_w) // 2
    cap_y = win_y + win_h + 28

    img = Image.new('RGB', (W, H), hx(p['bg']))
    # vertical gradient backdrop (bg2 -> bg)
    top, bot = hx(p['bg2']), hx(p['bg'])
    px = img.load()
    for y in range(H):
        f = y / (H - 1)
        row = tuple(int(top[i] + (bot[i] - top[i]) * f) for i in range(3))
        for x in range(W):
            px[x, y] = row

    # soft drop shadow under the window
    shadow = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    sd = ImageDraw.Draw(shadow)
    sd.rounded_rectangle([win_x, win_y + 22, win_x + win_w, win_y + win_h + 22],
                         radius=RADIUS + 6, fill=(0, 0, 0, 150))
    shadow = shadow.filter(ImageFilter.GaussianBlur(34))
    img = Image.alpha_composite(img.convert('RGBA'), shadow)

    d = ImageDraw.Draw(img, 'RGBA')
    # window
    d.rounded_rectangle([win_x, win_y, win_x + win_w, win_y + win_h], radius=RADIUS,
                        fill=hx(p['surface']), outline=hx(p['border']), width=1)
    # slim title bar separator + Linux/GNOME-style window controls (min / max / close, right)
    d.line([win_x + 1, win_y + TITLE, win_x + win_w - 1, win_y + TITLE], fill=hx(p['border']), width=1)
    ctrl = hx(p['ctrl'])
    cy = win_y + TITLE // 2
    right = win_x + win_w - 28
    for i, kind in enumerate(('close', 'max', 'min')):
        cx = right - i * 34
        if kind == 'min':
            d.line([cx - 8, cy + 5, cx + 8, cy + 5], fill=ctrl, width=2)
        elif kind == 'max':
            d.rounded_rectangle([cx - 8, cy - 8, cx + 8, cy + 8], radius=2, outline=ctrl, width=2)
        else:
            d.line([cx - 7, cy - 7, cx + 7, cy + 7], fill=ctrl, width=2)
            d.line([cx - 7, cy + 7, cx + 7, cy - 7], fill=ctrl, width=2)
    tf = font('C:/Windows/Fonts/segoeui.ttf', 22)
    title = 'mcp-convention-gate'
    tb = d.textbbox((0, 0), title, font=tf)
    d.text(((W - (tb[2] - tb[0])) // 2, win_y + (TITLE - (tb[3] - tb[1])) // 2 - tb[1]),
           title, font=tf, fill=hx(p['titlefg']))
    # terminal screen backing (so the overlay blends seamlessly)
    d.rectangle([term_x, term_y, term_x + a.tw, term_y + a.th], fill=hx(p['surface']))

    # caption pill (semi-transparent)
    pill = Image.new('RGBA', (W, H), (0, 0, 0, 0))
    pd = ImageDraw.Draw(pill)
    pd.rounded_rectangle([cap_x, cap_y, cap_x + cap_w, cap_y + cap_h], radius=22,
                         fill=hx(p['pill']) + (235,))
    img = Image.alpha_composite(img, pill)

    img.convert('RGB').save(a.out)
    print(json.dumps(dict(term_x=term_x, term_y=term_y, cap_x=cap_x, cap_y=cap_y,
                          cap_w=cap_w, cap_h=cap_h, capfg=p['capfg'], name=p['name'])))


if __name__ == '__main__':
    main()
