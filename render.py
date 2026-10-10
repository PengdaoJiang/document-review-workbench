"""Bounded PDF crops from original or actual compiled output, never OCR truth."""
import json, sys, subprocess, os, re
from pathlib import Path
from pypdf import PdfReader
from PIL import Image, ImageDraw

job=json.loads(Path(sys.argv[1]).read_text(encoding='utf-8'))
out=Path(job['out']); out.mkdir(parents=True,exist_ok=True)
pdf=Path(job['pdf']); reader=PdfReader(pdf)
def render(page, label, box=None, exclusions=[]):
    p=reader.pages[page-1]
    # Coordinates are original PDF points, top-left, after crop/rotation.
    w,h=float(p.cropbox.width),float(p.cropbox.height)
    if int(p.rotation or 0)%180: w,h=h,w
    prefix=out/label
    cmd=[job['poppler'],'-f',str(page),'-l',str(page),'-singlefile','-r','160','-png',str(pdf),str(prefix)]
    r=subprocess.run(cmd,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=90,env={**os.environ,'OMP_NUM_THREADS':'1'})
    if r.returncode: raise RuntimeError(r.stderr.decode('utf8',errors='replace'))
    im=Image.open(str(prefix)+'.png').convert('RGB'); sx,sy=im.width/w,im.height/h
    draw=ImageDraw.Draw(im)
    for region in exclusions:
        if region['originalPage']==page:
            b=region['bbox'];draw.rectangle((b[0]*sx,b[1]*sy,b[2]*sx,b[3]*sy),fill='white')
    im.save(str(prefix)+'.png')
    result={'page':page,'width':w,'height':h,'rotation':int(p.rotation or 0),'pageFile':label+'.png'}
    if box:
        assert len(box)==4 and 0<=box[0]<box[2]<=w+1 and 0<=box[1]<box[3]<=h+1, 'Invalid source/candidate box'
        for suffix,b in [('crop',box),('context',[max(0,box[0]-30),max(0,box[1]-65),min(w,box[2]+30),min(h,box[3]+65)])]:
            im.crop(tuple(round(v*s) for v,s in zip(b,[sx,sy,sx,sy]))).save(out/(label+'-'+suffix+'.png'))
        result.update(bbox=box,cropFile=label+'-crop.png',contextFile=label+'-context.png')
    return result

if job['kind']=='source':
    page=job['locator']['page']; assert page not in job['boundaries']['excludedOriginalPages'], 'Excluded source page'
    result={'method':'Poppler 160 dpi, original PDF, mapped exclusions painted white','pages':[render(page,'source',job['locator']['bbox'],job['boundaries']['excludedRegions'])]}
else:
    # SyncTeX binds source-line ranges to the PDF generated in this exact run.
    text=Path(job['targetFile']).read_text(encoding='utf-8')
    lines=sorted(set([job['startLine'],job['endLine']]+list(range(job['startLine'],job['endLine']+1,max(1,(job['endLine']-job['startLine'])//24)))))
    boxes={};raw=[]
    for line in lines:
        cmd=[job['synctex'],'view','-i',f"{line}:0:{job['targetFile']}",'-o',str(pdf)]
        r=subprocess.run(cmd,stdout=subprocess.PIPE,stderr=subprocess.PIPE,timeout=20,env={**os.environ,'SYNCTEX_VIEWER':''})
        s=r.stdout.decode('utf8',errors='replace');raw.append(s)
        records=re.split(r'(?m)^Page:',s)[1:]
        for record in records:
            fields=dict(re.findall(r'(?m)^([A-Za-z]+):([^\r\n]+)', 'Page:'+record))
            try:
                pg=int(fields['Page']);h0=float(fields['h']);v=float(fields['v']);ww=float(fields['W']);hh=float(fields['H'])
                if not (1<=pg<=len(reader.pages)):continue
                boxes.setdefault(pg,[]).append([h0,v-hh,h0+ww,v])
            except (KeyError,ValueError):continue
    (out/'synctex-lookup.txt').write_text('\n'.join(raw),encoding='utf-8')
    assert boxes, 'No unambiguous SyncTeX location for editable target; use owner-authored body anchor'
    assert len(boxes)<=6, 'Target maps to too many pages; split the review item'
    pages=[]
    for pg,bs in sorted(boxes.items()):
        p=reader.pages[pg-1];w,h=float(p.cropbox.width),float(p.cropbox.height)
        box=[max(0,min(b[0] for b in bs)-12),max(0,min(b[1] for b in bs)-20),min(w,max(b[2] for b in bs)+12),min(h,max(b[3] for b in bs)+20)]
        pages.append(render(pg,'candidate-'+str(pg),box))
    result={'method':'SyncTeX exact target lines in this compiled snapshot; boxes are navigation aids, inspect context/PDF as needed','pages':pages,'totalPages':len(reader.pages)}
(out/'render.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(result,ensure_ascii=False))
