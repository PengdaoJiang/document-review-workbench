"""Trusted mathematical AST interpreter. No eval, exec, sympify(text), imports or paths from a task."""
import json, sys, hashlib, os
sys.stdin.reconfigure(encoding='utf-8');sys.stdout.reconfigure(encoding='utf-8')
import sympy as s

class Gap(Exception): pass
class Encoding(Exception): pass
task=json.load(sys.stdin)
variables={name:s.Symbol(name, **({'real':True} if item['domain']=='real' else {'integer':True} if item['domain']=='integer' else {'complex':True})) for name,item in task['variables'].items()}
obligations=[]
scoped_obligations=[]
active_binders=set()
rv=[]
moments={}

def regularity(x):
    """Sufficient smoothness conditions for ordinary calculus, never a branch guess."""
    if not isinstance(x,list): return
    op,*args=x
    if op in ('min','max','arg','expect','cov','sum','integral'):
        raise NotImplementedError('Calculus regularity for '+op+' is outside this adapter')
    if op in ('log','sqrt','abs'):
        value=expression(args[0])
        if value.is_real is not True: raise Gap('Calculus with '+op+' requires an explicitly real argument and a verified regular domain')
        obligations.append((s.Ne(value,0) if op=='abs' else s.Gt(value,0),op+' calculus regularity'))
    if op=='matrix':
        for row in args[0]:
            for item in row: regularity(item)
    elif op not in ('const','decimal'):
        for item in args: regularity(item)

def expectation(value):
    if not rv: raise Gap('An explicit joint moment model is required; no independence or zero moments are inferred')
    try: poly=s.Poly(s.expand(value),*rv)
    except s.PolynomialError: raise Gap('This expectation needs moments or a distribution beyond the supplied polynomial moment table')
    total=0
    for powers, coefficient in poly.terms():
        if sum(powers)==0: moment=s.Integer(1)
        elif powers in moments: moment=moments[powers]
        else: raise Gap('Missing explicitly supplied joint moment '+str(powers))
        total+=coefficient*moment
    return s.expand(total)

def expression(x):
    if isinstance(x,int): return s.Integer(x)
    if isinstance(x,str): return variables[x]
    op,*args=x
    if op=='const': return {'I':s.I,'pi':s.pi,'E':s.E}[args[0]]
    if op=='decimal': return s.Rational(args[0])
    if op=='matrix': return s.Matrix([[expression(v) for v in row] for row in args[0]])
    if op in ('sum','integral'):
        if active_binders: raise NotImplementedError('Nested bound-variable calculus needs a separate scoped encoding in this adapter')
        value,index,lo,hi=args
        lo,hi=expression(lo),expression(hi)
        symbol=variables[index]
        if symbol in lo.free_symbols|hi.free_symbols: raise Encoding('A bound cannot depend on its own bound variable')
        if op=='sum' and (lo.is_integer is not True or hi.is_integer is not True): raise Encoding('Finite sum endpoints must be integers')
        if op=='sum' and lo.is_number and hi.is_number and (hi-lo)>100000: raise Encoding('Finite sum exceeds configured bound')
        if op=='sum': obligations.append((s.Ge(hi,lo-1),'ordinary finite sum bounds'))
        if op=='integral' and (lo.is_real is not True or hi.is_real is not True): raise Gap('A real integration interval is required; no complex contour is inferred')
        start=len(obligations)
        active_binders.add(index)
        if op=='integral': regularity(value)
        integrand=expression(value)
        active_binders.remove(index)
        inner=obligations[start:];del obligations[start:]
        for condition,why in inner:
            if symbol in condition.free_symbols:
                scoped_obligations.append((condition,why,symbol,lo,hi,op))
            else: obligations.append((condition,why))
        answer=(s.Sum if op=='sum' else s.Integral)(integrand,(symbol,lo,hi)).doit()
        if answer.has(s.Integral,s.Sum,s.oo,-s.oo,s.zoo,s.nan): raise Gap('A finite evaluated calculus expression was not established')
        return answer
    if op=='diff':
        regularity(args[0])
        value=s.diff(expression(args[0]),variables[args[1]],args[2])
        obligations.append((s.Ne(s.denom(s.together(value)),0),'derivative denominator'))
        return value
    a=[expression(v) for v in args]
    if op=='div': obligations.append((s.Ne(a[1],0), 'division denominator')); return a[0]/a[1]
    if op=='pow':
        if a[1].is_integer is not True:
            if a[0].is_real is not True: raise Gap('A noninteger power requires a verified positive real base in this adapter')
            obligations.append((s.Gt(a[0],0),'noninteger power domain'))
        elif a[1].is_nonnegative is not True: obligations.append((s.Ne(a[0],0),'possibly negative power base'))
        return a[0]**a[1]
    if op=='inverse': obligations.append((s.Ne(a[0].det(),0),'matrix inverse determinant')); return a[0].inv()
    if op=='expect': return expectation(a[0])
    if op=='cov': return expectation(a[0]*a[1])-expectation(a[0])*expectation(a[1])
    if op in ('log','arg'): obligations.append((s.Ne(a[0],0),'principal '+op+' argument'))
    if op=='tan': obligations.append((s.Ne(s.cos(a[0]),0),'tangent pole'))
    f={'add':lambda a,b:a+b,'sub':lambda a,b:a-b,'mul':lambda a,b:a*b,'min':s.Min,'max':s.Max,
       'sin':s.sin,'cos':s.cos,'tan':s.tan,'exp':s.exp,'log':s.log,'sqrt':s.sqrt,'abs':s.Abs,'conj':s.conjugate,
       're':s.re,'im':s.im,'arg':s.arg,'transpose':lambda a:a.T,'adjoint':lambda a:a.H,'det':lambda a:a.det(),
       'trace':lambda a:s.trace(a),'dot':lambda a,b:a*b}[op]
    return f(*a)

def relation(r): return {'eq':s.Eq,'ne':s.Ne,'gt':s.Gt,'ge':s.Ge,'lt':s.Lt,'le':s.Le}[r[0]](expression(r[1]),expression(r[2]))

def implied(rel, assumptions):
    rel=s.simplify(rel)
    assumptions=[s.simplify(a) for a in assumptions]
    if rel==s.true or rel in assumptions: return True
    try:
        answer=s.ask(s.Q.is_true(rel),s.And(*assumptions))
        if answer is not None: return bool(answer)
    except (ValueError,TypeError,IndexError,NotImplementedError): pass
    symbols=rel.free_symbols|set().union(*(a.free_symbols for a in assumptions))
    if len(symbols)==1:
        try:
            if s.reduce_inequalities([*assumptions,s.Not(rel)],list(symbols))==s.false: return True
        except (NotImplementedError,TypeError,ValueError): pass
    return False

def statistical():
    import numpy as np
    q=task['statistics'];mean=np.array(q['mean'],dtype=float);cov=np.array(q['covariance'],dtype=float)
    if not np.allclose(cov,cov.T,rtol=0,atol=1e-14) or np.linalg.eigvalsh(cov).min() < -1e-12: raise Encoding('The explicitly provided covariance must be symmetric positive semidefinite')
    generator=np.random.default_rng(q['seed']);draws=generator.multivariate_normal(mean,cov,size=q['count'],check_valid='raise')
    a=np.array(q['coefficientsA']);b=np.array(q['coefficientsB']);x=draws@a;y=draws@b
    batches=np.array([np.cov(xx,yy,ddof=1)[0,1] for xx,yy in zip(np.split(x,q['batches']),np.split(y,q['batches']))])
    return {'assessment':'statistical_observation','conclusion':'unknown','expectedCovariance':float(a@cov@b),'sampleCovariance':float(np.cov(x,y,ddof=1)[0,1]),'batchStandardErrorEstimate':float(batches.std(ddof=1)/(q['batches']**0.5)),'samples':q['count'],'seed':q['seed'],'distribution':q['distribution'],'scope':'Finite seeded sampling from the explicitly encoded distribution only. Standard error is a batch estimate, not a rigorous bound or universal proof.'}

def calculate():
    assumptions=[relation(r) for r in task['assumptions']]
    if s.simplify(s.And(*assumptions))==s.false: raise Encoding('Contradictory explicit assumptions')
    if task['kind']=='statistics': return statistical()
    if task.get('randomModel'):
        model=task['randomModel'];rv.extend(variables[x] for x in model['variables'])
        for item in model['moments']:
            value=expression(item['value'])
            if value.free_symbols.intersection(rv): raise Encoding('A supplied moment must not contain its random variables')
            moments[tuple(item['powers'])]=value
    left,right=expression(task['left']),expression(task['right'])
    # A binder shadows external assumptions on its dummy variable. Establish
    # integrand conditions over the complete interval, not at a selected point.
    for condition,why,symbol,lo,hi,op in scoped_obligations:
        outer=[a for a in assumptions if symbol not in a.free_symbols]
        interval=[s.Ge(symbol,s.Min(lo,hi)),s.Le(symbol,s.Max(lo,hi))] if op=='integral' else [s.Ge(symbol,lo),s.Le(symbol,hi)]
        if not implied(condition,outer+interval): raise Gap('Unproved '+why+' throughout the '+op+' interval: '+str(condition))
    if isinstance(left,s.MatrixBase)!=isinstance(right,s.MatrixBase): raise Encoding('Scalar/matrix target mismatch')
    if isinstance(left,s.MatrixBase) and left.shape!=right.shape: raise Encoding('Matrix dimensions differ')
    difference=left-right
    if task['kind']=='numeric':
        points=[]
        for sample in task['samples']:
            values={variables[k]:s.Rational(str(v)) for k,v in sample.items()}
            for name,v in sample.items():
                if task['variables'][name]['domain']=='integer' and int(v)!=v: raise Encoding('Sample violates an integer domain')
            for condition in assumptions+[o[0] for o in obligations]:
                if s.simplify(condition.subs(values))!=s.true: raise Encoding('Sample does not establish every explicit condition and denominator')
            exact=s.simplify(difference.subs(values))
            entries=list(exact) if isinstance(exact,s.MatrixBase) else [exact]
            if any(v.free_symbols or v.has(s.zoo,s.nan,s.oo,-s.oo) for v in entries): raise Encoding('Sample is incomplete or singular')
            errors=[abs(s.N(v,task['precision'])) for v in entries]
            residual=max(errors);tolerance=s.Rational(task['tolerance'])
            exact_counter=any(v.is_zero is False and v.is_Rational for v in entries) if task['claim']=='equal' else all(v==0 and v.is_Rational for v in entries)
            points.append({'sample':sample,'difference':str(exact),'maximumResidual':str(residual),'withinTolerance':bool(residual<=tolerance),'exactRationalCounterexample':bool(exact_counter)})
        counterexample=any(x['exactRationalCounterexample'] for x in points)
        all_small=all(x['withinTolerance'] for x in points)
        return {'assessment':'exact_counterexample' if counterexample else 'numeric_observation','claimTruth':'false' if counterexample else 'unknown','conclusion':'contradiction' if counterexample else 'unknown','points':points,'precision':task['precision'],'scope':'These explicit admissible points only. Finite agreement cannot prove the submitted universal equality or inequality; non-rational residuals remain numerical observations.'}
    missing=[{'condition':str(rel),'reason':why} for rel,why in obligations if not implied(rel,assumptions)]
    if missing: return {'assessment':'condition_gap','conclusion':'unknown','missing':missing,'scope':'The source audit must establish these well-definedness conditions; none were silently inserted.'}
    simplified=s.refine(s.simplify(difference),s.And(*assumptions))
    if any(v['domain']=='complex' for v in task['variables'].values()): simplified=s.simplify(s.expand_complex(simplified))
    entries=list(simplified) if isinstance(simplified,s.MatrixBase) else [simplified]
    equal=all(s.simplify(x)==0 for x in entries)
    unequal=any(implied(s.Ne(x,0),assumptions) for x in entries)
    claim_truth=(equal if task['claim']=='equal' else unequal) if equal or unequal else None
    return {'assessment':'symbolic_identity' if equal else 'symbolic_inequality' if unequal else 'unresolved_symbolic','claimTruth':'true' if claim_truth is True else 'false' if claim_truth is False else 'unknown','conclusion':'checked_no_contradiction' if claim_truth is True else 'contradiction' if claim_truth is False else 'unknown','left':str(left),'right':str(right),'difference':str(simplified),'assumptions':[str(a) for a in assumptions],'obligations':[str(x[0]) for x in obligations],'scope':'Conclusion evaluates the submitted equal or not_equal claim under exactly the listed domains and conditions; not a Lean proof, source-fidelity verdict or whole-paper validation. A supplied moment table is conditional data, not a proof that a probability distribution with those moments exists.'}

try:
    result=calculate()
except Gap as error: result={'assessment':'condition_gap','conclusion':'unknown','reason':str(error)}
except (Encoding,ValueError,TypeError,KeyError,ZeroDivisionError,s.matrices.exceptions.MatrixError) as error: result={'assessment':'encoding_error','conclusion':'encoding_error','reason':str(error)[:1000]}
except NotImplementedError as error: result={'assessment':'unsupported','conclusion':'unknown','reason':str(error)[:1000]}
result.update({'claim':task['claim'],'verdictVersion':2})
files={}
for module in list(sys.modules.values()):
    filename=getattr(module,'__file__',None)
    if filename and os.path.isfile(filename):
        with open(filename,'rb') as handle: files[os.path.abspath(filename)]=hashlib.sha256(handle.read()).hexdigest()
dependencies={'python':sys.version,'sympy':s.__version__,'numpy':getattr(sys.modules.get('numpy'),'__version__',None),'files':files}
wire=json.dumps(dependencies,sort_keys=True,ensure_ascii=False).encode('utf-8')
with open('dependencies.json','wb') as handle: handle.write(wire)
result['dependenciesSha256']=hashlib.sha256(wire).hexdigest()
print(json.dumps(result,ensure_ascii=False))
