import os
OUT = '/home/user/bonded/brand'
os.makedirs(OUT, exist_ok=True)
GREEN, INK, PAPER, DPAPER, DINK, DGREEN = '#2f5d3a', '#111111', '#fffff8', '#151411', '#ece6d6', '#8cc59b'

# Geometric B, upright in a 37x50 box, counters cut with evenodd, then slanted like the italic wordmark.
B = ("M0 0H21C29 0 34 5 34 12.5C34 17.5 31.5 21 27.5 23C33.5 24.8 37 29.5 37 36C37 44.5 31 50 22 50H0Z"
     "M11 9H19.5C22.8 9 24.5 10.8 24.5 13.6C24.5 16.4 22.8 18.4 19.5 18.4H11Z"
     "M11 27H20.5C24.2 27 26.2 29.2 26.2 32.6C26.2 36 24.2 41 20.5 41H11Z")

def glyph(fill, cx=50, cy=50, h=42):
    s = h / 50
    # center the slanted glyph: skew moves the top left by 50*tan(12deg)~10.6 units
    w = 37 * s; shift = 10.6 * s / 2
    x0 = cx - w / 2 + shift; y0 = cy - h / 2
    return f'<path transform="translate({x0:.2f} {y0:.2f}) skewX(-12) scale({s:.4f})" fill="{fill}" fill-rule="evenodd" d="{B}"/>'

def mark(ring, disc, letter, bg=None, size=100, ring_w=3.2):
    r = f'<rect width="100" height="100" fill="{bg}"/>' if bg else ''
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="{size}" height="{size}">{r}'
            f'<circle cx="50" cy="50" r="{46 - ring_w/2:.2f}" fill="none" stroke="{ring}" stroke-width="{ring_w}"/>'
            f'<circle cx="50" cy="50" r="37" fill="{disc}"/>{glyph(letter, h=40)}</svg>')

files = {
 'bonded-mark.svg': mark(GREEN, GREEN, PAPER),
 'bonded-mark-dark.svg': mark(DGREEN, DGREEN, DPAPER),
 'bonded-mark-mono.svg': mark(INK, INK, PAPER),
}
# Lockup: mark + italic wordmark (wordmark as live text in SVG, Inter ExtraBold Italic; PNGs are the safe use)
def lockup(ring, letter, ink, bg=None):
    r = f'<rect width="560" height="140" fill="{bg}"/>' if bg else ''
    m = mark(ring, ring, letter).replace('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="100" height="100">', '<svg x="20" y="20" width="100" height="100" viewBox="0 0 100 100">')
    return (f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 560 140" width="560" height="140">{r}{m}'
            f'<text x="146" y="101" font-family="Inter, Helvetica, Arial, sans-serif" font-style="italic" font-weight="800" font-size="84" letter-spacing="-2.5" fill="{ink}">Bonded</text></svg>')
files['bonded-lockup.svg'] = lockup(GREEN, PAPER, INK)
files['bonded-lockup-dark.svg'] = lockup(DGREEN, DPAPER, DINK)
for n, s in files.items(): open(f'{OUT}/{n}', 'w').write(s)

# X avatar (circle-cropped by X), and favicon
open(f'{OUT}/x-avatar.svg', 'w').write(
  f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="400" height="400"><rect width="100" height="100" fill="{PAPER}"/>'
  f'<circle cx="50" cy="50" r="30" fill="{GREEN}"/><circle cx="50" cy="50" r="35.5" fill="none" stroke="{GREEN}" stroke-width="2.4"/>{glyph(PAPER, h=33)}</svg>')
print(open(f'{OUT}/bonded-mark.svg').read())
