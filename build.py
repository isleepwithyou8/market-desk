import json,sys
snap=json.load(open(sys.argv[1]))
snap['EIN']=[e for e in snap.get('EIN',[]) if not str(e.get('ticker','')).endswith('.BO')]
# compact
js=json.dumps(snap,separators=(',',':')).replace('</','<\\/')
app=open('src/app.html').read()
eng=open('engine.js').read()
out=app.replace('/*__ENGINE__*/',eng).replace('__SNAPSHOT__',js)
open('index.html','w').write(out)
print('index.html',len(out))
