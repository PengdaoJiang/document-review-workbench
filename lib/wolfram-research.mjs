import {check} from './io.mjs';
import {validateResearch,PROFILES} from './research-math.mjs';

// Compile a data-only AST. No task strings become executable Wolfram source.
export function wolframProgram(t){
  validateResearch(t);check(['symbolic','numeric'].includes(t.kind),'Wolfram adapter accepts symbolic and explicit-point numeric jobs',422,'TOOL_UNSUPPORTED');
  const names=Object.keys(t.variables),symbols=Object.fromEntries(names.map((n,i)=>[n,'v'+i])),guards=[];let serial=0;
  const list=a=>'{'+a.join(',')+'}',str=JSON.stringify,call=(h,...a)=>h+'['+a.join(',')+']';
  const rational=s=>{const neg=s.startsWith('-'),a=(neg?s.slice(1):s).split('.');return (neg?'-':'')+(a.join(''))+(a[1]?'/10^'+a[1].length:'');};
  const guard=(s,scope)=>guards.push(scope?call('ForAll',scope.symbol,call('Implies',scope.interval,s)):s);
  const regular=(x,env,scope)=>{if(!Array.isArray(x))return;const [op,a]=x;
    check(!['min','max','arg','expect','cov','sum','integral'].includes(op),'This calculus regularity is not supported',422,'TOOL_UNSUPPORTED');
    if(['log','sqrt','abs'].includes(op)){const z=expr(a,env,scope);guard(call('Element',z,'Reals'),scope);guard(call(op==='abs'?'Unequal':'Greater',z,'0'),scope);}
    if(op==='matrix')x[1].flat().forEach(a=>regular(a,env,scope));else if(!['const','decimal'].includes(op))x.slice(1).forEach(a=>regular(a,env,scope));
  };
  const expr=(x,env=symbols,scope=null)=>{
    if(Number.isSafeInteger(x))return String(x);if(typeof x==='string')return env[x];const [op,a,b,c,d]=x;
    if(op==='const')return {I:'I',pi:'Pi',E:'E'}[a];if(op==='decimal')return '('+rational(a)+')';
    if(op==='matrix')return list(a.map(row=>list(row.map(v=>expr(v,env,scope)))));
    if(['sum','integral'].includes(op)){
      check(!scope,'Nested binders require a separately scoped encoding',422,'TOOL_UNSUPPORTED');
      const lo=expr(c,env),hi=expr(d,env),symbol='b'+serial++,e={...env,[b]:symbol};
      check(!JSON.stringify([c,d]).includes('"'+b+'"'),'A bound cannot depend on its own bound variable',422,'ENCODING_ERROR');
      if(op==='sum'){guard(call('Element',lo,'Integers'));guard(call('Element',hi,'Integers'));guard(call('GreaterEqual',hi,call('Subtract',lo,'1')));}
      else {guard(call('Element',lo,'Reals'));guard(call('Element',hi,'Reals'));}
      const interval=op==='sum'?call('And',call('Element',symbol,'Integers'),call('LessEqual',lo,symbol,hi)):call('And',call('Element',symbol,'Reals'),call('LessEqual',call('Min',lo,hi),symbol,call('Max',lo,hi)));
      const inner={symbol,interval};if(op==='integral')regular(a,e,inner);
      return call(op==='sum'?'Sum':'Integrate',expr(a,e,inner),list([symbol,lo,hi]));
    }
    if(op==='diff'){regular(a,env,scope);return call('D',expr(a,env,scope),list([env[b],String(c)]));}
    const A=expr(a,env,scope),B=b===undefined?null:expr(b,env,scope);
    if(op==='div')guard(call('Unequal',B,'0'),scope);
    if(op==='pow'){
      if(!Number.isInteger(b)&&!(typeof b==='string'&&t.variables[b].domain==='integer')){
        // The exponent can be an exact integer expression, e.g. 2/2. Its
        // syntax is not evidence of a fractional power; prove the domain.
        guard(call('Or',call('And',call('Element',B,'Integers'),call('Or',call('Greater',B,'0'),call('Unequal',A,'0'))),call('And',call('Element',A,'Reals'),call('Greater',A,'0'))),scope);
      }
      else if(!Number.isInteger(b)||b<=0)guard(call('Unequal',A,'0'),scope);
    }
    if(op==='inverse')guard(call('Unequal',call('Det',A),'0'),scope);
    if(['log','arg'].includes(op))guard(call('Unequal',A,'0'),scope);
    if(op==='tan')guard(call('Unequal',call('Cos',A),'0'),scope);
    const heads={add:'typedAdd',sub:'typedSubtract',mul:'scalarProduct',div:'Divide',pow:'Power',min:'Min',max:'Max',sin:'Sin',cos:'Cos',tan:'Tan',exp:'Exp',log:'Log',sqrt:'Sqrt',abs:'Abs',conj:'Conjugate',re:'Re',im:'Im',arg:'Arg',transpose:'Transpose',adjoint:'ConjugateTranspose',det:'Det',inverse:'Inverse',trace:'Tr',dot:'typedDot',expect:'jointMean',cov:'jointCov'};
    return call(heads[op],...([A,B].filter(x=>x!==null)));
  };
  const assumptions=t.assumptions.map(([op,a,b])=>call({eq:'Equal',ne:'Unequal',gt:'Greater',ge:'GreaterEqual',lt:'Less',le:'LessEqual'}[op],expr(a),expr(b)));
  const domains=names.map(n=>call('Element',symbols[n],{real:'Reals',integer:'Integers',complex:'Complexes'}[t.variables[n].domain]));
  const random=t.randomModel,rv=random?random.variables.map(n=>symbols[n]):[];
  const moments=random?random.moments.map(m=>str(m.powers.join(','))+'->'+expr(m.value)):[];
  const left=expr(t.left),right=expr(t.right),guardText=list(guards),profile=PROFILES[t.profile||'standard'];
  const samples=t.samples?.map(s=>list(Object.entries(s).map(([k,v])=>symbols[k]+'->('+rational(String(v))+')')))||[];
  check(!t.samples?.some(s=>Object.values(s).some(v=>/[eE]/.test(String(v)))),'Explicit numeric points must have an ordinary decimal representation',422,'ENCODING_ERROR');
  const code=`ClearAll["Global\u0060*"]; $HistoryLength=0; $Assumptions=True;
gap[msg_] := Throw[<|"assessment"->"condition_gap","conclusion"->"unknown","reason"->msg|>];
enc[msg_] := Throw[<|"assessment"->"encoding_error","conclusion"->"encoding_error","reason"->msg|>];
txt[x_] := ToString[x,InputForm];
shape[x_] := If[ListQ[x],Dimensions[x],{}];
typedAdd[x_,y_] := If[shape[x]===shape[y],x+y,enc["Addition dimensions differ"]];
typedSubtract[x_,y_] := If[shape[x]===shape[y],x-y,enc["Subtraction dimensions differ"]];
scalarProduct[x_,y_] := If[ListQ[x]&&ListQ[y],enc["Use explicit dot for a matrix product"],x y];
typedDot[x_,y_] := If[MatrixQ[x]&&MatrixQ[y]&&Last[Dimensions[x]]===First[Dimensions[y]],Dot[x,y],enc["Explicit dot requires compatible matrix dimensions"]];
rv=${list(rv)}; moments=<|${moments.join(',')}|>;
jointMean[x_] := Module[{rules},If[Length[rv]==0,gap["Explicit joint moments required; independence is not inferred"]]; If[!PolynomialQ[Expand[x],rv],gap["Polynomial moment table cannot evaluate this expectation"]];rules=CoefficientRules[Expand[x],rv];Total[Map[Function[r,Last[r] If[Total[First[r]]==0,1,With[{key=StringRiffle[ToString /@ First[r],","]},If[KeyExistsQ[moments,key],moments[key],gap["Missing explicitly supplied joint moment "<>key]]]]],rules]]];
jointCov[x_,y_] := jointMean[x y]-jointMean[x] jointMean[y];
result=TimeConstrained[MemoryConstrained[Catch[Module[{assume,defined,conditionSources,l,r,diff,ans,missing,points,exact,values,entries,residual,counter,requirements},
assume=And@@${list([...domains,...assumptions])};
If[TrueQ[FullSimplify[assume]==False],enc["Contradictory explicit assumptions"]];
If[!FreeQ[Values[moments],Alternatives@@rv]&&Length[rv]>0,enc["Supplied moments cannot contain random variables"]];
defined=${guardText};
conditionSources=${list(guards.map(str))};
missing=Select[Range[Length[defined]],!TrueQ[FullSimplify[defined[[#]],Assumptions->assume]]&];
${t.kind==='symbolic'?'If[Length[missing]>0,Throw[<|"assessment"->"condition_gap","conclusion"->"unknown","missing"->(txt /@ defined[[missing]]),"missingDetails"->Map[Function[i,<|"index"->i,"expression"->conditionSources[[i]],"evaluated"->txt[defined[[i]]],"simplified"->txt[FullSimplify[defined[[i]],Assumptions->assume]]|>],missing]|>]];':''}
l=${left};r=${right};
If[!FreeQ[{l,r},Indeterminate|ComplexInfinity|DirectedInfinity|_Sum|_Integrate|_Derivative],gap["A finite evaluated expression was not established"]];
If[shape[l]=!=shape[r],enc["Scalar/matrix shapes differ"]];diff=l-r;
${t.kind==='numeric'?`points=Table[values=s;
requirements=Join[{assume},defined]/.values;If[!And@@(TrueQ[FullSimplify[#,Assumptions->And@@${list(domains)}]]& /@ requirements),enc["Sample fails explicit domains or well-definedness conditions"]];
exact=FullSimplify[diff/.values];entries=Flatten[{exact}];If[!And@@(NumberQ /@ entries)||!FreeQ[entries,Indeterminate|ComplexInfinity|DirectedInfinity],enc["Sample is incomplete or singular"]];
residual=Max[Abs[N[entries,${t.precision}]]];counter=${t.claim==='equal'?'AnyTrue[entries,(IntegerQ[#]||Head[#]===Rational)&&#!=0&]':'AllTrue[entries,(IntegerQ[#]||Head[#]===Rational)&&#==0&]'};
<|"point"->(txt /@ values),"difference"->txt[exact],"maximumResidual"->txt[residual],"withinTolerance"->TrueQ[residual<=${rational(t.tolerance)}],"exactRationalCounterexample"->counter|>,{s,${list(samples)}}];
counter=AnyTrue[points,TrueQ[#["exactRationalCounterexample"]]&];<|"assessment"->If[counter,"exact_counterexample","numeric_observation"],"claimTruth"->If[counter,"false","unknown"],"conclusion"->If[counter,"contradiction","unknown"],"points"->points|>`:`ans=FullSimplify[And@@(Map[#==0&,Flatten[{diff}]]),Assumptions->assume];
<|"assessment"->If[TrueQ[ans],"symbolic_identity",If[ans===False,"symbolic_inequality","unresolved_symbolic"]],"claimTruth"->If[TrueQ[ans],"${t.claim==='equal'?'true':'false'}",If[ans===False,"${t.claim==='equal'?'false':'true'}","unknown"]],"conclusion"->If[TrueQ[ans],"${t.claim==='equal'?'checked_no_contradiction':'contradiction'}",If[ans===False,"${t.claim==='equal'?'contradiction':'checked_no_contradiction'}","unknown"]],"left"->txt[l],"right"->txt[r],"difference"->txt[FullSimplify[diff,Assumptions->assume]],"assumptions"->txt[assume],"obligations"->(txt /@ defined)|>`}
]],${Math.max(256,profile.memoryMiB-256)}*1024^2,<|"assessment"->"resource_memory","conclusion"->"unknown"|>],${Math.max(10,profile.timeoutMs/1000-8)},<|"assessment"->"resource_timeout","conclusion"->"unknown"|>];
If[!AssociationQ[result],result=<|"assessment"->"runtime_failure","conclusion"->"unknown"|>];
result=Join[result,<|"claim"->"${t.claim}","verdictVersion"->2,"engine"->"Wolfram Language","version"->$Version,"processId"->$ProcessID,"parallelKernels"->Length[Kernels[]],"scope"->"The conclusion evaluates the submitted claim (equal or not_equal), not an implicit equality or the whole paper. CAS evidence for exactly the audited domains, assumptions and expressions. Explicit moments are conditional data; their realizability is not proved. Not a formal proof or source-fidelity verdict."|>];
WriteString["stdout","REVIEW_RESULT:",ExportString[result,"RawJSON","Compact"->True],"\\n"];Quit[];
`;
  return {code,symbolMap:Object.fromEntries(Object.entries(symbols).map(([a,b])=>[b,a]))};
}
