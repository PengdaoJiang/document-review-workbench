"""Trusted one-child resource launcher; not a filesystem/network security sandbox."""
import ctypes as c, ctypes.wintypes as w, subprocess, sys, os, json, threading, time
sys.stdin.reconfigure(encoding='utf-8');sys.stdout.reconfigure(encoding='utf-8')
spec=json.load(sys.stdin)
if spec.get('registration'):
    identity_path='runner-identity.json'
    with open(identity_path+'.tmp', 'w', encoding='utf-8') as handle: json.dump({'pid':os.getpid(),'parentPid':os.getppid(),'token':spec['registration']['token']},handle)
    os.replace(identity_path+'.tmp',identity_path)
def registered_actor():
    registration=spec.get('registration')
    if not registration: return 0
    timeout_ms=spec.get('registrationTimeoutMs')
    if timeout_ms!=30000: raise RuntimeError('REGISTRY_HANDSHAKE_BUDGET_INVALID')
    started=time.monotonic()
    deadline=started+timeout_ms/1000
    while time.monotonic()<deadline:
        with open(registration['path'],encoding='utf-8-sig') as handle: current=json.load(handle)
        if current.get('state')!='held' or current.get('token')!=registration['token'] or current.get('ownerPid')!=registration['ownerPid']: raise RuntimeError('REGISTRY_FENCED')
        if any(actor['pid']==os.getpid() and actor['kind']=='runner' and actor.get('parentPid')==os.getppid() for actor in current['actors']): return round((time.monotonic()-started)*1000)
        time.sleep(0.1)
    print(json.dumps({'errorCode':'REGISTRY_ACTOR_TIMEOUT','phase':'runner_registration','engineStarted':False,'registrationElapsedMs':round((time.monotonic()-started)*1000)}))
    sys.exit(3)
registration_elapsed_ms=registered_actor()
assert os.name=='nt', 'This deployment requires the verified Windows Job Object launcher'
class Basic(c.Structure):
    _fields_=[('PerProcessUserTimeLimit',c.c_longlong),('PerJobUserTimeLimit',c.c_longlong),('LimitFlags',w.DWORD),('MinimumWorkingSetSize',c.c_size_t),('MaximumWorkingSetSize',c.c_size_t),('ActiveProcessLimit',w.DWORD),('Affinity',c.c_size_t),('PriorityClass',w.DWORD),('SchedulingClass',w.DWORD)]
class IO(c.Structure): _fields_=[(name,c.c_ulonglong) for name in ['ReadOperationCount','WriteOperationCount','OtherOperationCount','ReadTransferCount','WriteTransferCount','OtherTransferCount']]
class Extended(c.Structure): _fields_=[('BasicLimitInformation',Basic),('IoInfo',IO),('ProcessMemoryLimit',c.c_size_t),('JobMemoryLimit',c.c_size_t),('PeakProcessMemoryUsed',c.c_size_t),('PeakJobMemoryUsed',c.c_size_t)]
k=c.WinDLL('kernel32',use_last_error=True)
class MemoryStatus(c.Structure): _fields_=[('dwLength',w.DWORD),('dwMemoryLoad',w.DWORD),('ullTotalPhys',c.c_ulonglong),('ullAvailPhys',c.c_ulonglong),('ullTotalPageFile',c.c_ulonglong),('ullAvailPageFile',c.c_ulonglong),('ullTotalVirtual',c.c_ulonglong),('ullAvailVirtual',c.c_ulonglong),('ullAvailExtendedVirtual',c.c_ulonglong)]
memory=MemoryStatus();memory.dwLength=c.sizeof(memory)
if not k.GlobalMemoryStatusEx(c.byref(memory)) or memory.ullAvailPhys<(int(spec['memoryMiB'])+4096)*1048576: raise RuntimeError('Insufficient physical-memory headroom for this declared profile plus 4 GiB reserve')
k.CreateJobObjectW.argtypes=[c.c_void_p,w.LPCWSTR];k.CreateJobObjectW.restype=w.HANDLE
k.SetInformationJobObject.argtypes=[w.HANDLE,c.c_int,c.c_void_p,w.DWORD];k.SetInformationJobObject.restype=w.BOOL
k.AssignProcessToJobObject.argtypes=[w.HANDLE,w.HANDLE];k.AssignProcessToJobObject.restype=w.BOOL
k.CloseHandle.argtypes=[w.HANDLE];k.GetCurrentProcess.restype=w.HANDLE
k.GetProcessAffinityMask.argtypes=[w.HANDLE,c.POINTER(c.c_size_t),c.POINTER(c.c_size_t)]
job=k.CreateJobObjectW(None,None)
if not job: raise c.WinError(c.get_last_error())
limits=Extended();limits.BasicLimitInformation.LimitFlags=0x2000|0x100|0x200|0x8|0x10
limits.BasicLimitInformation.ActiveProcessLimit=2 if spec.get('pythonVenv') else 1;limits.ProcessMemoryLimit=int(spec['memoryMiB'])*1024*1024
limits.JobMemoryLimit=limits.ProcessMemoryLimit
process_mask,system_mask=c.c_size_t(),c.c_size_t()
if not k.GetProcessAffinityMask(k.GetCurrentProcess(),c.byref(process_mask),c.byref(system_mask)): raise c.WinError(c.get_last_error())
limits.BasicLimitInformation.Affinity=process_mask.value & -process_mask.value
if not k.SetInformationJobObject(job,9,c.byref(limits),c.sizeof(limits)): raise c.WinError(c.get_last_error())
env={key:os.environ[key] for key in ['SystemRoot','WINDIR','COMSPEC'] if key in os.environ}
env.update({'PATH':os.path.dirname(spec['program'])+os.pathsep+os.path.join(env['SystemRoot'],'System32'),'TEMP':os.getcwd(),'TMP':os.getcwd(),'HOME':os.getcwd(),'USERPROFILE':os.getcwd(),'OMP_NUM_THREADS':'1','OPENBLAS_NUM_THREADS':'1','MKL_NUM_THREADS':'1','LEAN_NUM_THREADS':'1'})
if spec.get('leanPath'): env['LEAN_PATH']=spec['leanPath']
# Wolfram may need the installed licensing profile. No task expression can read it.
if spec.get('licenseProfile'):
    for key in ['USERPROFILE','APPDATA','LOCALAPPDATA','ProgramData']:
        if key in os.environ: env[key]=os.environ[key]
    for key in ['WOLFRAM_BASE','WOLFRAM_USERBASE','WOLFRAM_LOCALBASE']:
        if key in spec.get('licenseEnvironment',{}): env[key]=spec['licenseEnvironment'][key]
p=subprocess.Popen([spec['program'],*spec['args']],stdin=subprocess.PIPE,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,env=env,cwd=os.getcwd(),creationflags=subprocess.CREATE_NO_WINDOW|0x4)
k.GetProcessTimes.argtypes=[w.HANDLE,c.POINTER(w.FILETIME),c.POINTER(w.FILETIME),c.POINTER(w.FILETIME),c.POINTER(w.FILETIME)]
created,exited,kernel_time,user_time=w.FILETIME(),w.FILETIME(),w.FILETIME(),w.FILETIME()
if not k.GetProcessTimes(w.HANDLE(int(p._handle)),c.byref(created),c.byref(exited),c.byref(kernel_time),c.byref(user_time)): p.kill();p.wait();raise c.WinError(c.get_last_error())
child_created_at=(created.dwHighDateTime<<32)|created.dwLowDateTime
if not k.AssignProcessToJobObject(job,w.HANDLE(int(p._handle))):
    p.kill();p.wait();raise c.WinError(c.get_last_error())
class ThreadEntry(c.Structure): _fields_=[('dwSize',w.DWORD),('cntUsage',w.DWORD),('th32ThreadID',w.DWORD),('th32OwnerProcessID',w.DWORD),('tpBasePri',w.LONG),('tpDeltaPri',w.LONG),('dwFlags',w.DWORD)]
k.CreateToolhelp32Snapshot.argtypes=[w.DWORD,w.DWORD];k.CreateToolhelp32Snapshot.restype=w.HANDLE
k.Thread32First.argtypes=[w.HANDLE,c.POINTER(ThreadEntry)];k.Thread32Next.argtypes=[w.HANDLE,c.POINTER(ThreadEntry)]
k.OpenThread.argtypes=[w.DWORD,w.BOOL,w.DWORD];k.OpenThread.restype=w.HANDLE
k.ResumeThread.argtypes=[w.HANDLE];k.ResumeThread.restype=w.DWORD
snapshot=k.CreateToolhelp32Snapshot(4,0);entry=ThreadEntry();entry.dwSize=c.sizeof(entry);threads=[]
more=k.Thread32First(snapshot,c.byref(entry))
while more:
    if entry.th32OwnerProcessID==p.pid: threads.append(entry.th32ThreadID)
    more=k.Thread32Next(snapshot,c.byref(entry))
k.CloseHandle(snapshot)
if len(threads)!=1: p.kill();p.wait();raise RuntimeError('Cannot identify the sole suspended task-owned main thread')
thread_handle=k.OpenThread(2,False,threads[0])
if not thread_handle or k.ResumeThread(thread_handle)!=1: p.kill();p.wait();raise RuntimeError('Suspended main thread did not resume exactly once')
k.CloseHandle(thread_handle)
execution_started=time.monotonic()
with open('child.json','w') as handle: json.dump({'pid':p.pid,'limits':'Windows Job Object before resume','memoryMiB':spec['memoryMiB'],'workers':1,'affinityMask':limits.BasicLimitInformation.Affinity,'activeProcessLimit':limits.BasicLimitInformation.ActiveProcessLimit,'pythonVenvRedirector':bool(spec.get('pythonVenv'))},handle)
chunks=[];overflow=[False]
def capture():
    total=0
    while True:
        part=p.stdout.read(4096)
        if not part: break
        total+=len(part)
        if total>131072: overflow[0]=True;p.kill();break
        chunks.append(part)
thread=threading.Thread(target=capture,daemon=True);thread.start()
try: p.stdin.write(spec.get('input','').encode('utf-8'));p.stdin.close()
except BrokenPipeError: pass
timed_out=False
try: p.wait(timeout=spec['timeoutMs']/1000)
except subprocess.TimeoutExpired: timed_out=True;p.kill();p.wait()
thread.join(timeout=5)
result={'code':p.returncode,'childPid':p.pid,'childCreatedAt':str(child_created_at),'childCreationTimeFormat':'Windows FILETIME 100ns since 1601 UTC','timedOut':timed_out,'overflow':overflow[0],'output':b''.join(chunks).decode('utf-8',errors='replace'),'memoryMiB':spec['memoryMiB'],'workers':1,'jobObject':True,'filesystemSandbox':False,'networkSandbox':False}
result.update({'registrationElapsedMs':registration_elapsed_ms,'executionElapsedMs':round((time.monotonic()-execution_started)*1000),'executionTimingScope':'Resumed child wall time including result collection; not pure symbolic-kernel CPU time.'})
k.CloseHandle(job)
print(json.dumps(result,ensure_ascii=False))
