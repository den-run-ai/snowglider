from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
import json, hashlib
root=Path('/workspace/scratch/a21195a756ba/wind-evidence')
font='/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf'
bold='/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'
outputs=[]
for stem,title in [('desktop-follow','Desktop follow camera'),('desktop-crosswind-detail','Crosswind orbit camera')]:
    before=Image.open(root/f'before-{stem}.png').convert('RGB')
    after=Image.open(root/f'after-{stem}.png').convert('RGB')
    assert before.size==after.size==(960,540)
    board=Image.new('RGB',(1968,704),'#101e2d')
    d=ImageDraw.Draw(board)
    d.text((16,12),title,font=ImageFont.truetype(bold,32),fill='#f0f6fc')
    d.text((16,62),'BASE 5738d94',font=ImageFont.truetype(bold,24),fill='#c8d4df')
    d.text((992,62),'PR 9660fc0 runtime',font=ImageFont.truetype(bold,24),fill='#7cdbc8')
    board.paste(before,(16,104));board.paste(after,(992,104))
    d.text((16,660),'Actual production renders | Seed 1393582293 | Low tier | Real EZ trees | Identical prescribed replay',font=ImageFont.truetype(font,22),fill='#c8d4df')
    file={'desktop-follow':'desktop-follow-before-after.webp','desktop-crosswind-detail':'crosswind-detail-before-after.webp'}[stem]
    target=root/file
    quality=88
    while True:
        board.save(target,'WEBP',quality=quality,method=6)
        if target.stat().st_size<500000 or quality<=60:break
        quality-=4
    outputs.append({'file':file,'width':1968,'height':704,'webpQuality':quality,'bytes':target.stat().st_size,'sourceImages':[f'before-{stem}.png',f'after-{stem}.png'],'processing':'Original screenshots pasted at native resolution; external labels and lossy WebP encoding only.'})
    print(file,target.stat().st_size)
phone=Image.open(root/'after-phone-follow.png').convert('RGB')
phone.save(root/'phone-follow-after.webp','WEBP',quality=92,method=6)
outputs.append({'file':'phone-follow-after.webp','width':phone.width,'height':phone.height,'webpQuality':92,'bytes':(root/'phone-follow-after.webp').stat().st_size,'sourceImages':['after-phone-follow.png'],'processing':'Original full screenshot at native resolution; WebP encoding only.'})
meta=json.loads((root/'visual-metadata.json').read_text())
for line in (root/'visual-capture.log').read_text().splitlines():
    if line.startswith('{"revision":"after"'):
        meta['captures'].append(json.loads(line))
meta['captures'].append({'revision':'after','device':'desktop','file':'after-desktop-crosswind-detail.png','view':'player orbit closeup','errors':[]})
phone_meta=json.loads((root/'phone-after-metadata.json').read_text())
meta['captures'].extend(phone_meta['captures'])
meta['capturedAtEnd']=phone_meta['capturedAt']
meta['runtimeRevision']='9660fc069c86b4a777f978a4b33e030c93922e8f'
meta['headRevision']='2cb650ea898c6ba6af8b606061fe9e83590c7248'
meta['revisionExplanation']='Production dist built from 9660fc0; captured with working tree at 2cb650ea. Git diff confirms intervening changes are six test files only, with no runtime source changes.'
meta['devices']={'desktop':{'width':960,'height':540,'deviceScaleFactor':1},'phone':{'width':390,'height':844,'deviceScaleFactor':1,'isMobile':True,'hasTouch':True,'qualification':'Chromium viewport/touch emulation; not a physical-phone performance test.'}}
meta['cameraExplanation']='Follow: prescribed downhill replay, 8 physics/render steps followed by 2 follow-camera settling steps. Orbit: same replay followed by yaw 0.65, zoom multiplier 0.6, and 2 further steps.'
meta['animation']={'status':'not delivered','reason':'Optional full-scene animation capture was stopped after the software GPU process was killed (exit 9); no animation result or hardware-performance claim is made.'}
meta['boards']=outputs
meta['artifacts']=[]
files=[*sorted(root.glob('before-*.png')),*sorted(root.glob('after-*.png')),*[root/o['file'] for o in outputs]]
for p in files:
    meta['artifacts'].append({'file':p.name,'bytes':p.stat().st_size,'sha256':hashlib.sha256(p.read_bytes()).hexdigest()})
(root/'visual-capture-manifest.json').write_text(json.dumps(meta,indent=2)+'\n')
raw=Path('/tmp/tree-wind-probe.json').read_text();probe=json.loads(raw[raw.index('{\n'):])
probe['qualification']='Isolated full material/depth render qualification; these draw/program counts are diagnostic, not full-player performance metrics.'
(root/'tree-wind-initial-render-metrics.json').write_text(json.dumps(probe,indent=2)+'\n')
