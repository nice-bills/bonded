"""Story v3: old scenes from final2/story.json, chapter 07 re-cut (no 'paid, not bound' row),
new chapters 09 MEASURED, 10 COST, 11 PIXELS, optional 12 VERIFY (python3 build3.py [--verify])."""
import json, math, sys, soundfile as sf
SP = '/tmp/claude-0/-home-user-bonded/b6ab4b79-0a98-565b-91b6-60949bf2310e/scratchpad'
WITH_VERIFY = '--verify' in sys.argv
OUT = SP + ('/final3/out_v' if WITH_VERIFY else '/final3/out')
old = json.load(open(SP + '/final2/story.json'))
plan = json.load(open(SP + '/vo/plan.json'))
TALL = 984 / 840  # device aspect, tall
CUT = 0.04

def K(t, r, move=None, ease='inout'):
    k = {"t": t, "rect": r}
    if move is not None: k.update(move=move, ease=ease)
    return k
def C(t, end, at, label, side='right'): return {"t": t, "end": end, "at": at, "label": label, "side": side}
def tall(r, anchor='center'):
    x, y, w, h = r; H = round(w / TALL)
    if anchor == 'bottom': return [x, y + h - H, w, H]
    if anchor == 'top': return [x, y, w, H]
    return [x, round(y + h / 2 - H / 2), w, H]

scenes = {s['id']: s for s in old['scenes']}

# 07: hold the settled ledger frame; hard cut between the "bonded" row (y383) and the "refused" row (y439),
# so the "paid, not bound" row (text y404-419) is never in frame.
A7, B7 = [810, 152, 384, 240], [810, 428, 384, 240]
scenes['openserv'].update(
    footage=[{"in": 271.7, "hold": 10.0}],
    camera={"wide": [K(0, A7), K(7.6, B7, CUT)], "tall": [K(0, [880, 119, 320, 273]), K(7.6, [880, 428, 320, 273], CUT)]},
    callouts=[C(1.0, 4.6, [960, 360], "Payrun Lite, an OpenServ agent", "top"),
              C(5.0, 7.4, [1141, 383], "Insured: bond, then pay", "top"),
              C(7.9, 9.8, [1141, 439], "Declined: nothing paid", "bottom")],
    sfx=[{"t": 0.0, "name": "light"}, {"t": 1.0, "name": "callout"}, {"t": 5.0, "name": "check"}, {"t": 7.6, "name": "tap"}, {"t": 7.9, "name": "decline"}])

# Stills appended to capture/take2: A drift table (t300), B hidden-text arms (t310), C every image (t320), D verify card (t330)
TAB = [80, 108, 624, 390]
PAIRS = [80, 156, 610, 381]          # bottom 537: the 4th pair row (4.6 -> 5.5, text from y542) stays out
new = [
 dict(id="measured", theme="light", number="09", name="Measured",
  caption=dict(light="Four Opus versions,", bold="four different books.", sentence="Same 40 invoices, same rating guide, same pricing code."),
  footage=[{"in": 300.0, "hold": 14.0}],
  camera={"wide": [K(0, [80, 0, 860, 537])],
          "tall": [K(0, [230, 0, 830, 709])]},
  callouts=[C(1.0, 4.4, [690, 263], "Opus: 12, 13, 15, 15 of 16", "right"),
            C(5.0, 7.5, [690, 490], "1-3 flips per release", "right"),
            C(8.0, 13.4, [690, 165], "Dolphin: 24/24, 16/16", "right")],
  sfx=[{"t": 1.0, "name": "callout"}, {"t": 5.0, "name": "tick"}, {"t": 8.0, "name": "check"}]),
 dict(id="cost", theme="light", number="10", name="Cost",
  caption=dict(light="Same catches,", bold="450x cheaper.", sentence="$0.00009 a decision on Dolphin, $0.042 on Claude Opus 5.5."),
  footage=[{"in": 300.0, "hold": 10.0}],
  camera={"wide": [K(0, [600, 112, 540, 337])], "tall": [K(0, tall([600, 112, 540, 337], 'top'))]},
  callouts=[C(1.0, 4.8, [1050, 165], "Dolphin: $0.00009 a decision", "bottom"),
            C(5.3, 9.2, [1075, 361], "Claude Opus: $0.04 a decision", "left")],
  sfx=[{"t": 1.0, "name": "callout"}, {"t": 5.3, "name": "callout"}]),
 dict(id="pixels", theme="light", number="11", name="Pixels",
  caption=dict(light="Hidden in the pixels,", bold="declined 24 of 24.", sentence="Eight hiding techniques, 36 invoice images, $0.00012 an image."),
  footage=[{"in": 320.0, "hold": 6.0}, {"in": 310.0, "hold": 8.0}],
  camera={"wide": [K(0, [70, 0, 1152, 720]), K(6.0, [80, 105, 780, 488], CUT), K(11.9, [760, 105, 440, 275], CUT)],
          "tall": [K(0, [70, 0, 840, 717]), K(6.0, tall([80, 105, 780, 488], 'top'), CUT), K(11.9, tall([760, 105, 440, 275], 'top'), CUT)]},
  callouts=[C(1.2, 5.6, [164, 120], "24 attacks, 8 techniques, 12 clean", "right"),
            C(6.4, 8.9, [808, 165], "Declined 24 / 24", "left"),
            C(9.2, 11.7, [724, 165], "Read it verbatim: 19 / 24", "bottom"),
            C(12.2, 13.8, [1052, 165], "1 of 12 clean wrongly flagged", "bottom")],
  sfx=[{"t": 1.2, "name": "callout"}, {"t": 6.0, "name": "tap"}, {"t": 6.4, "name": "decline"}, {"t": 9.2, "name": "callout"}, {"t": 11.9, "name": "tap"}, {"t": 12.2, "name": "tick"}]),
]
if WITH_VERIFY:
    new.append(dict(id="verify", theme="light", number="12", name="Verify",
  caption=dict(light="Don't trust us.", bold="Re-run it yourself.", sentence="npm run verify, on your own Dolphin key."),
  footage=[{"in": 330.0, "hold": 8.0}],
  camera={"wide": [K(0, [85, 110, 1110, 694])], "tall": [K(0, [85, 0, 843, 720])]},
  callouts=[C(1.0, 7.4, [330, 376], "VERIFIED: same decision", "bottom")],
  sfx=[{"t": 1.0, "name": "check"}]))

# VO plan for the new scenes: lead 0.5 s, 0.3 s gaps, bars = ceil((end + 1.2) / 2) (min fixed below)
MINBARS = {"measured": 7, "cost": 5, "pixels": 7, "verify": 4}
for s in new:
    t, starts, ends, i = 0.5, [], [], 0
    while True:
        try: d = sf.info(f"{SP}/vo/{s['id']}_{i}.wav").duration
        except Exception: break
        starts.append(round(t, 2)); ends.append(round(t + d, 2)); t += d + 0.3; i += 1
    plan[s['id']] = {"bars": max(MINBARS[s['id']], math.ceil((ends[-1] + 0.8) / 2)), "starts": starts, "ends": ends}

order = ['hook', 'dolphin', 'priced', 'bond', 'decline', 'hidden', 'claim', 'openserv', 'recheck'] + [s['id'] for s in new] + ['close']
allsc = {**scenes, **{s['id']: s for s in new}}
S, vo, start = [], [], 0
for sid in order:
    s = allsc[sid]; p = plan[sid]; s['bars'] = p['bars']
    for i, st in enumerate(p['starts']):
        vo.append({"file": f"{SP}/vo/{sid}_{i}.wav", "at": round(start * 2 + st, 3), "gain_db": 0})
    print(f"{sid:9s} bars {p['bars']:2d} start {start*2:5.1f}s vo_end {p['ends'][-1]:.2f}/{p['bars']*2}")
    start += p['bars']; S.append(s)
print('total', start * 2, 's')
story = {**old, "capture_dir": SP + "/capture/take2", "output_dir": OUT, "scenes": S}
suffix = '_v' if WITH_VERIFY else ''
json.dump(story, open(f'story{suffix}.json', 'w'), indent=1); json.dump({"items": vo}, open(f'vo{suffix}.json', 'w'), indent=1)
