#!/usr/bin/env python3
"""Carry a chapter's translation onto a freshly re-detected copy of it.

    scripts/merge-translations.py OLD/chapter.json NEW/chapter.json [--apply]

OLD is the chapter that holds the translation (en, type, tags) but stale or
missing detect geometry. NEW is the same pages, freshly detected in another
chapter folder: its lines carry jp + detect boxes and empty en.

Pages pair by position. Within a page a NEW line takes the OLD line whose jp is
the closest match (exact first, then normalised, then fuzzy >= 0.6). Everything
that did not pair cleanly is printed for a manual pass. Without --apply nothing
is written; with it NEW/chapter.json is rewritten in place (a .bak-pre-merge
copy is kept beside it). Run the app's open on NEW afterwards so translations.json
is regenerated from it.
"""
import json, re, sys, shutil, difflib
from pathlib import Path

def norm(s):
    s = (s or '')
    s = re.sub(r'[\s　]+', '', s)
    s = re.sub(r'[。、．，！？!?…‥・「」『』（）()\-—―ー~〜■□]', '', s)
    return s

def main():
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    apply = '--apply' in sys.argv
    if len(args) != 2:
        print(__doc__); sys.exit(2)
    old_p, new_p = Path(args[0]), Path(args[1])
    old, new = json.loads(old_p.read_text()), json.loads(new_p.read_text())
    op, np_ = old['pages'], new['pages']
    if len(op) != len(np_):
        print(f'!! page count differs: old {len(op)} new {len(np_)} - pairing by position anyway')
    report = []
    carried = 0
    for i, (a, b) in enumerate(zip(op, np_)):
        pid = b.get('id', i + 1)
        pool = list(a.get('lines', []))
        used = set()
        for ln in b.get('lines', []):
            jp = ln.get('jp', '')
            best, score, how = None, 0.0, None
            for j, ol in enumerate(pool):
                if j in used: continue
                ojp = ol.get('jp', '')
                if ojp == jp: best, score, how = j, 1.0, 'exact'; break
                if norm(ojp) and norm(ojp) == norm(jp):
                    if score < 0.99: best, score, how = j, 0.99, 'norm'
                    continue
                r = difflib.SequenceMatcher(None, norm(ojp), norm(jp)).ratio()
                if r > score: best, score, how = j, r, 'fuzzy'
            if best is not None and score >= 0.6:
                ol = pool[best]; used.add(best)
                ln['en'] = ol.get('en', '')
                if ol.get('type'): ln['type'] = ol['type']
                if ol.get('tags'): ln['tags'] = list(ol['tags'])
                carried += 1
                if how == 'fuzzy':
                    report.append(f'p{pid} n{ln["n"]} FUZZY {score:.2f}\n    new: {jp}\n    old: {ol.get("jp","")}\n    en : {ln["en"]}')
            else:
                ln['en'] = ln.get('en', '') or ''
                report.append(f'p{pid} n{ln["n"]} UNMATCHED (new detect, no old line)\n    new: {jp}')
        for j, ol in enumerate(pool):
            if j not in used:
                report.append(f'p{pid} old n{ol.get("n")} MISSED by new detect (translation orphaned)\n    old: {ol.get("jp","")}\n    en : {ol.get("en","")}')
    total_old = sum(len(p.get('lines', [])) for p in op)
    total_new = sum(len(p.get('lines', [])) for p in np_)
    no_geom = [p.get('id') for p in np_ if not p.get('detect')]
    print(f'old lines {total_old}  new lines {total_new}  carried {carried}  needs manual {len(report)}')
    if no_geom: print(f'!! NEW pages with no detect geometry: {no_geom}')
    print('\n'.join(report))
    if apply:
        bak = new_p.with_name(new_p.name + '.bak-pre-merge')
        shutil.copy2(new_p, bak)
        new_p.write_text(json.dumps(new, ensure_ascii=False, indent=2))
        print(f'\nwrote {new_p} (backup {bak})')
    else:
        print('\n(dry run - add --apply to write)')

if __name__ == '__main__':
    main()
