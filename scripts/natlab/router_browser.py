"""One isolated Chromium WebTransport dial, with Merkur session-key admission."""
import asyncio
import argparse
import json
import os
from pathlib import Path
import subprocess
import tempfile
import urllib.request
import websockets


async def command(ws, method, params, counter=[0]):
    counter[0]+=1
    n=counter[0]
    await ws.send(json.dumps(dict(id=n,method=method,params=params)))
    while True:
        answer=json.loads(await ws.recv())
        if answer.get('id')==n:return answer


async def main(args):
    coords=json.loads(Path(args.coordinates).read_text())
    async def page(reader,writer):
        await reader.read(8192)
        writer.write(b'HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n')
        await writer.drain();writer.close()
    http=await asyncio.start_server(page,'127.0.0.1',0)
    origin=http.sockets[0].getsockname()[1]
    profile=Path(tempfile.mkdtemp(prefix='nr-browser-',dir='/tmp'))
    log=Path(args.output+'.stderr').open('w')
    chrome=subprocess.Popen(['chromium','--headless=new','--no-sandbox','--disable-dev-shm-usage',
                             '--disable-background-networking','--disable-component-update','--disable-sync',
                             '--no-first-run','--remote-debugging-port=0','--user-data-dir='+str(profile),
                             '--log-net-log='+args.output+'.netlog.json','--net-log-capture-mode=Everything','about:blank'],stdout=log,stderr=log)
    result={}
    try:
        active=profile/'DevToolsActivePort'
        deadline=asyncio.get_running_loop().time()+15
        while True:
            lines=active.read_text().splitlines() if active.exists() else []
            if len(lines)>=2 and lines[0].isdigit() and lines[1].startswith('/devtools/browser/'):
                port=int(lines[0]);break
            if chrome.poll() is not None or asyncio.get_running_loop().time()>deadline:
                raise RuntimeError('Chromium startup failed')
            await asyncio.sleep(.01)
        req=urllib.request.Request(f'http://127.0.0.1:{port}/json/new?http://127.0.0.1:{origin}',method='PUT')
        target=json.loads(await asyncio.to_thread(lambda:urllib.request.urlopen(req).read()))
        async with websockets.connect(target['webSocketDebuggerUrl'],max_size=4*1024*1024) as ws:
            version=await command(ws,'Browser.getVersion',{})
            await command(ws,'Page.navigate',{'url':f'http://127.0.0.1:{origin}'})
            await asyncio.sleep(.15)
            expression=r'''(async()=>{
              const c=COORDINATES;
              const unb64=s=>Uint8Array.from(atob(s.replace(/-/g,'+').replace(/_/g,'/')),x=>x.charCodeAt(0));
              const wt=new WebTransport(TARGET,{serverCertificateHashes:[{algorithm:'sha-256',value:unb64(c.certHash)}]});
              const started=performance.now();
              let timer;
              const budget=new Promise((_,r)=>timer=setTimeout(()=>r(new Error('experiment-deadline')),BUDGET));
              async function attempt(){
                await wt.ready;
                const handshakeMs=performance.now()-started;
                const channels={};
                for(const id of [2,1,4]){
                  const stream=await wt.createBidirectionalStream();
                  const writer=stream.writable.getWriter();await writer.write(new Uint8Array([id]));
                  channels[id]={writer,reader:stream.readable.getReader(),buffer:new Uint8Array()};
                }
                const enc=new TextEncoder();
                async function send(ch,bytes){
                  const b=new Uint8Array(4+bytes.length);new DataView(b.buffer).setUint32(0,bytes.length);b.set(bytes,4);await ch.writer.write(b);
                }
                async function read(ch){
                  while(true){
                    if(ch.buffer.length>=4){
                      const n=new DataView(ch.buffer.buffer,ch.buffer.byteOffset,4).getUint32(0);
                      if(n>1048576)throw new Error('bad frame size');
                      if(ch.buffer.length>=n+4){const out=ch.buffer.slice(4,4+n);ch.buffer=ch.buffer.slice(4+n);return out;}
                    }
                    const next=await ch.reader.read();if(next.done)throw new Error('stream ended');
                    const joined=new Uint8Array(ch.buffer.length+next.value.length);joined.set(ch.buffer);joined.set(next.value,ch.buffer.length);ch.buffer=joined;
                  }
                }
                const ctrl=channels[2];
                await send(ctrl,enc.encode(JSON.stringify({type:'webtransport_upgrade_init',browser_node_id:c.browserId})));
                const challenge=JSON.parse(new TextDecoder().decode(await read(ctrl)));
                if(challenge.type!=='webtransport_upgrade_challenge')throw new Error('no challenge: '+JSON.stringify(challenge));
                const transcript=['merkur-webtransport-upgrade-proof',challenge.nonce_hex,c.sessionId,c.browserId,c.daemonId,challenge.temp_peer_id].join('\n');
                const key=await crypto.subtle.importKey('raw',unb64(c.upgradeSecret),{name:'HMAC',hash:'SHA-512'},false,['sign']);
                const proof=new Uint8Array(await crypto.subtle.sign('HMAC',key,enc.encode(transcript)));
                const proofHex=Array.from(proof,x=>x.toString(16).padStart(2,'0')).join('');
                await send(ctrl,enc.encode(JSON.stringify({type:'webtransport_upgrade_proof',proof_hex:proofHex})));
                const ack=await read(ctrl);
                const echoes=[];
                for(let n=0;n<5;n++){
                  const text='authenticated-nat-research-'+n;
                  await send(channels[1],enc.encode(text));
                  const echo=new TextDecoder().decode(await read(channels[1]));
                  if(echo!==text)throw new Error('echo mismatch');echoes.push(echo);
                }
                return {ready:true,authenticated:true,handshakeMs,totalMs:performance.now()-started,ack:Array.from(ack),echoes};
              }
              try{return await Promise.race([attempt(),budget]);}
              catch(e){return {ready:false,error:String(e),totalMs:performance.now()-started};}
              finally{clearTimeout(timer);wt.close();}
            })()'''.replace('COORDINATES',json.dumps(coords)).replace('TARGET',json.dumps(f'https://{args.host}:{args.port}/')).replace('BUDGET',str(args.budget))
            response=await command(ws,'Runtime.evaluate',dict(expression=expression,awaitPromise=True,returnByValue=True))
            result=dict(browser=version.get('result'),response=response,target=f'{args.host}:{args.port}')
    finally:
        chrome.terminate()
        await asyncio.to_thread(chrome.wait)
        http.close();log.close()
        Path(args.output).write_text(json.dumps(result,indent=2))
        print(json.dumps(result),flush=True)


if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('--coordinates',required=True);p.add_argument('--host',required=True);p.add_argument('--port',type=int,required=True);p.add_argument('--output',required=True);p.add_argument('--budget',type=int,default=5000)
    asyncio.run(main(p.parse_args()))
