# Side-by-side: our real app crop (left) next to the matching Claude Design piece crop (right), same height.
import sys
from PIL import Image, ImageDraw
ours = 'C:/dev/hawl-ws-wt/D3-shots/'
cd = 'E:/hawl-platform/_work/2026-10-12-cd-full/pieces/'
pairs = [
  ('cmp-menu', ours+'menu-workspace-options-{t}.png', (200,215,540,705), cd+'F09/shot-r7.png', (730,585,1080,915), 'Menu: Hawl Workstation (real app) / Claude Design F09'),
  ('cmp-palette', ours+'palette-cursor-{t}.png', (250,50,1190,790), cd+'F09/shot-r7.png', (370,1655,1080,2190), 'Command menu: real app / F09'),
  ('cmp-toasts', ours+'toasts-{t}.png', (980,565,1430,875), cd+'F09/shot-r7.png', (930,3240,1370,3600), 'Toasts: real app / F09'),
  ('cmp-dialog', ours+'dialog-create-{t}.png', (440,215,1000,690), cd+'F10/shot-r5.png', (440,670,1030,1140), 'Dialog: real app / F10'),
]
for t in ['light']:
  for name,a,ac,b,bc,cap in pairs:
    A = Image.open(a.format(t=t)).convert('RGB').crop(ac); B = Image.open(b).convert('RGB').crop(bc)
    h = 640
    A = A.resize((int(A.width*h/A.height), h), Image.LANCZOS); B = B.resize((int(B.width*h/B.height), h), Image.LANCZOS)
    W = A.width+B.width+30; im = Image.new('RGB',(W,h+34),(245,240,230)); im.paste(A,(0,34)); im.paste(B,(A.width+30,34))
    ImageDraw.Draw(im).text((8,10),cap,fill=(20,36,58)); im.save(f'C:/dev/hawl-ws-wt/D3-shots/{name}-{t}.png'); print(name)
