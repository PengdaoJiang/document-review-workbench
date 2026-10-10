// Presentation only: uses the already sealed images, never edits or submits.
export function createImageViewers(){
 const panes=new Map(),link=document.querySelector('#zoom-link');let contentKey=null,returnFocus=null,bodyOverflow='';
 const dialog=document.createElement('dialog');dialog.id='image-viewer-dialog';dialog.setAttribute('aria-labelledby','image-viewer-title');
 const head=document.createElement('div');head.className='viewer-heading';const title=document.createElement('strong');title.id='image-viewer-title';const close=button('返回对照','关闭大图');head.append(title,close);
 const stage=document.createElement('div');stage.className='image-stage viewer-expanded-stage';stage.tabIndex=0;stage.setAttribute('aria-label','大图，放大后可拖动或使用方向键平移');
 const note=document.createElement('p');note.className='viewer-pixel-note';note.textContent='100% 对应原图像素。放大不会增加原图细节；可用原 PDF 补充查看。';
 const surface=document.createElement('div');surface.id='image-viewer-surface';surface.append(head,stage,note);dialog.append(surface);document.body.append(dialog);
 function button(text,label){const b=document.createElement('button');b.type='button';b.textContent=text;if(label)b.setAttribute('aria-label',label);return b;}
 function images(p){return [...p.stage.querySelectorAll('img')];}
 function fit(p){const list=images(p).filter(i=>i.naturalWidth);if(!list.length)return 100;return Math.max(5,Math.min(100,(p.stage.clientWidth-32)/Math.max(...list.map(i=>i.naturalWidth))*100,(p.stage.clientHeight-32)/Math.max(...list.map(i=>i.naturalHeight))*100));}
 function apply(p,zoom,mode='manual',anchor=null){
  const old=p.zoom||100,x=p.stage.scrollLeft+p.stage.clientWidth/2,y=p.stage.scrollTop+p.stage.clientHeight/2;
  p.zoom=Math.max(5,Math.min(1600,Number(zoom)||100));p.mode=mode;if(document.activeElement!==p.input)p.input.value=String(Math.round(p.zoom));
  for(const im of images(p)){if(im.naturalWidth)im.style.width=(im.naturalWidth*p.zoom/100)+'px';im.draggable=false;}
  p.stage.dataset.zoom=String(p.zoom);
  if(anchor){const r=anchor.image.getBoundingClientRect();p.stage.scrollLeft+=r.left+anchor.x*r.width-anchor.clientX;p.stage.scrollTop+=r.top+anchor.y*r.height-anchor.clientY;}
  else{p.stage.scrollLeft=Math.max(0,x*p.zoom/old-p.stage.clientWidth/2);p.stage.scrollTop=Math.max(0,y*p.zoom/old-p.stage.clientHeight/2);}
  p.minus.disabled=p.zoom<=5;p.plus.disabled=p.zoom>=1600;
 }
 function change(p,value,mode='manual'){const targets=p.name!=='expanded'&&link.checked?[...panes.values()]:[p];for(const target of targets)apply(target,mode==='fit'?fit(target):value,mode);}
 function controls(p){
  const row=document.createElement('div');row.className='image-tools';row.setAttribute('role','group');row.setAttribute('aria-label',p.label+'缩放工具');
  p.minus=button('−',p.label+'缩小');p.plus=button('+',p.label+'放大');p.input=document.createElement('input');p.input.type='number';p.input.min='5';p.input.max='1600';p.input.step='25';p.input.value='100';p.input.setAttribute('aria-label',p.label+'缩放百分比');
  const percent=document.createElement('label');percent.className='zoom-percent';percent.append(p.input,document.createTextNode('%'));const fitButton=button('适应窗口',p.label+'适应窗口'),native=button('100%',p.label+'原始像素');
  p.minus.onclick=()=>change(p,p.zoom/1.25);p.plus.onclick=()=>change(p,p.zoom*1.25);p.input.oninput=()=>{if(p.input.value)change(p,p.input.value);};p.input.onchange=()=>change(p,p.input.value);fitButton.onclick=()=>change(p,0,'fit');native.onclick=()=>change(p,100);
  row.append(p.minus,percent,p.plus,fitButton,native);return row;
 }
 function pan(p){let drag=null,suppressClick=false;
  p.stage.addEventListener('wheel',e=>{
   if(!e.ctrlKey)return;e.preventDefault();if(!e.deltaY)return;
   const list=images(p).filter(im=>im.naturalWidth),image=list.find(im=>{const r=im.getBoundingClientRect();return e.clientY>=r.top&&e.clientY<=r.bottom;})||list[0];if(!image)return;
   const r=image.getBoundingClientRect(),delta=e.deltaY*(e.deltaMode===1?16:e.deltaMode===2?p.stage.clientHeight:1);
   // This gesture always affects only its viewport, even when toolbar linking is on.
   apply(p,p.zoom*Math.exp(-Math.max(-240,Math.min(240,delta))*0.002),'manual',{image,x:(e.clientX-r.left)/r.width,y:(e.clientY-r.top)/r.height,clientX:e.clientX,clientY:e.clientY});
  },{passive:false});
  p.stage.addEventListener('pointerdown',e=>{if(e.button!==0)return;drag={id:e.pointerId,x:e.clientX,y:e.clientY,left:p.stage.scrollLeft,top:p.stage.scrollTop,moved:false};});
  p.stage.addEventListener('pointermove',e=>{if(!drag||drag.id!==e.pointerId)return;const dx=e.clientX-drag.x,dy=e.clientY-drag.y;if(Math.hypot(dx,dy)>4){drag.moved=true;p.stage.setPointerCapture(e.pointerId);p.stage.classList.add('panning');p.stage.scrollLeft=drag.left-dx;p.stage.scrollTop=drag.top-dy;e.preventDefault();}});
  const end=e=>{if(!drag||drag.id!==e.pointerId)return;suppressClick=drag.moved;if(p.stage.hasPointerCapture(e.pointerId))p.stage.releasePointerCapture(e.pointerId);drag=null;p.stage.classList.remove('panning');};
  p.stage.addEventListener('pointerup',end);p.stage.addEventListener('pointercancel',end);
  p.stage.addEventListener('click',e=>{if(suppressClick){suppressClick=false;return;}if(p.name!=='expanded'&&e.target.tagName==='IMG')open(p,e.target);});
  p.stage.addEventListener('keydown',e=>{if(p.name!=='expanded'&&e.target.tagName==='IMG'&&['Enter',' '].includes(e.key)){e.preventDefault();open(p,e.target);}});
  p.stage.addEventListener('load',()=>{if(p.mode==='fit')apply(p,fit(p),'fit');else apply(p,p.zoom);},true);
  new ResizeObserver(()=>{if(p.mode==='fit'&&(p.name!=='expanded'||dialog.open))apply(p,fit(p),'fit');}).observe(p.stage);
 }
 const expanded={name:'expanded',label:'大图',stage,mode:'fit',zoom:100},modalTools=controls(expanded);head.after(modalTools);pan(expanded);
 const full=button('全屏','大图全屏');full.hidden=!document.fullscreenEnabled;modalTools.append(full);full.onclick=async()=>{try{if(document.fullscreenElement===surface)await document.exitFullscreen();else await surface.requestFullscreen();}catch{note.textContent='浏览器未能进入全屏；仍可在当前大图中缩放和平移。100% 对应原图像素。';}};
 document.addEventListener('fullscreenchange',()=>{full.textContent=document.fullscreenElement===surface?'退出全屏':'全屏';if(dialog.open&&expanded.mode==='fit')apply(expanded,fit(expanded),'fit');});
 close.onclick=()=>dialog.close();dialog.addEventListener('close',()=>{if(document.fullscreenElement===surface)void document.exitFullscreen();document.body.style.overflow=bodyOverflow;stage.replaceChildren();returnFocus?.isConnected&&returnFocus.focus({preventScroll:true});});
 function open(p,image){if(dialog.open)return;returnFocus=document.activeElement;bodyOverflow=document.body.style.overflow;title.textContent=p.name==='source'?'原文 · 大图':document.querySelector('#candidate-title').textContent+' · 大图';stage.replaceChildren(...(image?[image]:images(p)).map(im=>{const clone=im.cloneNode();clone.removeAttribute('id');clone.removeAttribute('tabindex');clone.removeAttribute('role');clone.draggable=false;return clone;}));expanded.mode='fit';dialog.showModal();document.body.style.overflow='hidden';apply(expanded,fit(expanded),'fit');stage.scrollLeft=stage.scrollTop=0;close.focus();}
 for(const [name,label] of [['source','原文'],['candidate','候选与预览']]){const pane={name,label,stage:document.querySelector('#'+name+'-stage'),zoom:100,mode:'fit'};panes.set(name,pane);const row=controls(pane),expand=button('展开大图',label+'展开大图');expand.onclick=()=>open(pane);row.append(expand);pane.stage.before(row);pane.stage.tabIndex=0;pane.stage.setAttribute('aria-label',label+'，点图展开，放大后拖动或使用方向键平移');pan(pane);}
 return {setContent(key){if(key===contentKey)return;if(dialog.open)dialog.close();contentKey=key;for(const p of panes.values()){p.mode='fit';p.stage.scrollLeft=p.stage.scrollTop=0;}},refresh(){for(const p of panes.values()){for(const im of images(p)){im.tabIndex=0;im.setAttribute('role','button');im.setAttribute('aria-label',im.alt+'，展开大图');im.title='点图展开大图';}apply(p,p.mode==='fit'?fit(p):p.zoom,p.mode);}}};
}
