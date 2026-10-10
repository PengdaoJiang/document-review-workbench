"""One fresh process, no eval/import supplied by a role; exact rational evidence."""
import json,sys
from fractions import Fraction
def expr(x):
    if type(x) is int: return Fraction(x)
    op,*xs=x
    a=[expr(v) for v in xs]
    if op=='add': return a[0]+a[1]
    if op=='sub': return a[0]-a[1]
    if op=='mul': return a[0]*a[1]
    if op=='div': return a[0]/a[1]
    if op=='pow': return a[0]**int(a[1])
    if op=='min': return min(a)
    raise ValueError('unsupported operation')
data=json.load(sys.stdin)
left,right=expr(data['left']),expr(data['right'])
print(json.dumps({'left':str(left),'right':str(right),'equal':left==right,'precision':'exact_rational','claim':'this encoded instance only'}))
