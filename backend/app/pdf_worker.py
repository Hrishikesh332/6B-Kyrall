"""Bounded PDF extraction/rendering subprocess. It never executes PDF actions."""
import json
from pathlib import Path
import shutil
import subprocess
import sys


def extract(source, output, options):
    from pypdf import PdfReader
    reader=PdfReader(source)
    if reader.is_encrypted: raise ValueError('Encrypted PDFs are unsupported')
    if len(reader.pages)>500: raise ValueError('PDF exceeds 500 pages')
    output.mkdir(parents=True,exist_ok=True)
    start=options.get('page_start',1)
    count=options.get('page_count',2)
    query=options.get('find','').strip().casefold()
    if start>len(reader.pages): raise ValueError('Page number is outside the PDF')
    pages=[]
    for index in range(len(reader.pages)) if query else range(start-1,min(start-1+count,len(reader.pages))):
        page=reader.pages[index]
        contents=page.get_contents()
        if contents is not None and len(contents.get_data())>8_000_000: raise ValueError('PDF page content exceeds extraction budget')
        text=page.extract_text() or ''
        if query and query not in text.casefold(): continue
        page_result={'page':index+1,'text':text[:12000],'truncated':len(text)>12000}
        renderer=shutil.which('pdftoppm')
        if renderer:
            image=output/f'page_{index+1}'
            subprocess.run([renderer,'-f',str(index+1),'-l',str(index+1),'-singlefile','-scale-to','1600','-png',str(source),str(image)],check=True,timeout=10,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            page_result['image']=image.with_suffix('.png').name
        else: page_result['image_unavailable']='Install Poppler pdftoppm to inspect drawing pixels'
        pages.append(page_result)
        if len(pages)>=count: break
    return {'total_pages':len(reader.pages),'pages':pages,'find':query,'note':'PDF text may omit drawing dimensions; inspect page images before using mechanical interfaces.'}


if __name__=='__main__':
    import resource
    resource.setrlimit(resource.RLIMIT_CPU,(20,25))
    resource.setrlimit(resource.RLIMIT_FSIZE,(12*1024*1024,12*1024*1024))
    try:
        result=extract(Path(sys.argv[1]),Path(sys.argv[2]),json.loads(sys.argv[3]))
        print(json.dumps({'ok':True,**result}))
    except Exception as exc:
        print(json.dumps({'ok':False,'error':f'{type(exc).__name__}: {str(exc)[:500]}'}))
        sys.exit(1)
