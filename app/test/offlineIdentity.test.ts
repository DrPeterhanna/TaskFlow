import {expect,it} from 'vitest';
import {createOfflineIdentity,registerOfflineIdentity} from '../src/auth/offlineIdentity';
import {createSupabaseAuthApi} from '../src/auth/authController';
import type {SupabaseClient} from '@supabase/supabase-js';
const user={id:'12345678-1234-1234-1234-123456789abc',email:'local@test.invalid'};
function setup() {
 const values=new Map<string,string>();
 const storage={getItem:async(k:string)=>values.get(k)??null,setItem:async(k:string,v:string)=>{values.set(k,v);},removeItem:async(k:string)=>{values.delete(k);}};
 const identity=createOfflineIdentity(storage,'session');
 values.set('session',JSON.stringify({access_token:'synthetic-access',refresh_token:'synthetic-refresh',user}));
 let error:unknown={name:'AuthRetryableFetchError'};let callback:(event:string,s:unknown)=>void=()=>{};
 const client={auth:{getSession:async()=>({data:{session:null},error}),signOut:async()=>({error}),onAuthStateChange:(cb:typeof callback)=>{callback=cb;return {data:{subscription:{unsubscribe(){}}}};},signInWithPassword:async()=>({data:{session:{user}},error:null})}};
 registerOfflineIdentity(client,identity);
 return {values,identity,api:createSupabaseAuthApi(client as unknown as SupabaseClient),setError:(e:unknown)=>{error=e;},emit:(e:string,s:unknown)=>callback(e,s)};
}
it('only retryable refresh failure unlocks exact locally stored identity, never tokens',async()=>{
 const {api,setError}=setup();expect(await api.getSession()).toEqual({userId:user.id,email:user.email,localOnly:true});
 setError({name:'AuthApiError',status:400});expect(await api.getSession()).toBeNull();
 setError(null);expect(await api.getSession()).toBeNull();
});
it('explicit offline logout locks restart even when remote revocation fails; signin unlocks',async()=>{
 const {api,identity}=setup();await expect(api.signOut()).rejects.toBeTruthy();expect(await identity.read()).toBeNull();expect(await api.getSession()).toBeNull();
 expect((await api.signIn('local@test.invalid','not-a-real-password')).session?.userId).toBe(user.id);expect(await identity.locked()).toBe(false);
});
it('corrupt or partial session cannot unlock local task database',async()=>{
 const {identity,values}=setup();values.set('session','{}');expect(await identity.read()).toBeNull();values.set('session','{');expect(await identity.read()).toBeNull();
});
it('startup null event does not override offline identity; real signed out event still clears controller',async()=>{
 const {api,emit}=setup();const seen:unknown[]=[];api.onChange(s=>seen.push(s));emit('INITIAL_SESSION',null);expect(seen).toEqual([]);expect(await api.getSession()).not.toBeNull();emit('SIGNED_OUT',null);expect(seen).toEqual([null]);
});
it('late successful signin cannot reopen unlock after an intervening logout',async()=>{
 const values=new Map<string,string>();const storage={getItem:async(k:string)=>values.get(k)??null,setItem:async(k:string,v:string)=>{values.set(k,v);},removeItem:async(k:string)=>{values.delete(k);}};
 const identity=createOfflineIdentity(storage,'s');let finish!:(r:unknown)=>void;
 const client={auth:{signInWithPassword:()=>new Promise(r=>{finish=r;}),signOut:async()=>({error:null})}};
 registerOfflineIdentity(client,identity);const api=createSupabaseAuthApi(client as unknown as SupabaseClient);
 const pending=api.signIn('local@test.invalid','synthetic');await api.signOut();finish({data:{session:{user}},error:null});await pending;expect(await identity.locked()).toBe(true);
});
it('a real remote signout during a slow local storage read suppresses stale unlock',async()=>{
 const x=setup();let finish!:(r:Awaited<ReturnType<typeof x.identity.read>>)=>void;
 x.identity.read=()=>new Promise(r=>{finish=r;});const seen:unknown[]=[];x.api.onChange(s=>seen.push(s));
 const pending=x.api.getSession();await new Promise(r=>setTimeout(r,0));x.emit('SIGNED_OUT',null);finish({userId:user.id,email:user.email,localOnly:true});expect(await pending).toBeNull();expect(seen).toEqual([null]);
});
it('real signout event during signin is not hidden as a submission event',async()=>{
 const x=setup();const seen:unknown[]=[];x.api.onChange(s=>seen.push(s));
 const pending=x.api.signIn('local@test.invalid','synthetic');x.emit('SIGNED_OUT',null);await pending;expect(seen).toEqual([null]);
});
it('full origin including port has an independent session and logout lock key, never adopts legacy',async()=>{
 const {authStorageKey}=await import('../src/auth/offlineIdentity');expect(authStorageKey('http://127.0.0.1:54321')).not.toBe(authStorageKey('http://127.0.0.1:54322'));expect(authStorageKey('https://abc.example')).not.toBe(authStorageKey('http://abc.example'));expect(authStorageKey('http://127.0.0.1:54321')).toMatch(/^[A-Za-z0-9._-]+$/);
 const values=new Map([['sb-127-auth-token',JSON.stringify({access_token:'synthetic',refresh_token:'synthetic',user})]]);const storage={getItem:async(k:string)=>values.get(k)??null,setItem:async(k:string,v:string)=>{values.set(k,v);},removeItem:async(k:string)=>{values.delete(k);}};
 expect(await createOfflineIdentity(storage,authStorageKey('http://127.0.0.1:54321')).read()).toBeNull();expect(values.has('sb-127-auth-token')).toBe(true);
});
it('failed lock persistence still blocks current-process unlock and SDK cleanup is attempted',async()=>{
 let cleanup=0;const identity=createOfflineIdentity({getItem:async()=>null,setItem:async()=>{throw Error('storage full');},removeItem:async()=>{}},'session');
 const client={auth:{signOut:async()=>{cleanup++;return {error:null};}}};registerOfflineIdentity(client,identity);const api=createSupabaseAuthApi(client as unknown as SupabaseClient);
 await expect(api.signOut()).rejects.toThrow('local_logout_failed');expect(cleanup).toBe(1);expect(await identity.locked()).toBe(true);expect(await identity.read()).toBeNull();
});

it('logout persistence failure is visible and never reported as a successful logout',async()=>{
 const {createAuthController}=await import('../src/auth/authController');const x=setup();x.identity.lock=async()=>{throw Error('disk failure');};
 const controller=createAuthController(x.api);await controller.start();await expect(controller.signOut()).rejects.toThrow('local_logout_failed');expect(controller.getState()).toMatchObject({phase:'signedOut',error:'local_logout_failed'});controller.dispose();
});
it('combined durable-lock and SDK-cleanup failure stays explicitly unconfirmed, not a restart guarantee',async()=>{
 const {createAuthController}=await import('../src/auth/authController');let cleanup=0;
 const identity=createOfflineIdentity({getItem:async()=>null,setItem:async()=>{throw Error('disk unavailable');},removeItem:async()=>{throw Error('disk unavailable');}},'s');
 const client={auth:{getSession:async()=>({data:{session:{user}},error:null}),signOut:async()=>{cleanup++;throw Error('SDK storage cleanup failed');},onAuthStateChange:()=>({data:{subscription:{unsubscribe(){}}}})}};
 registerOfflineIdentity(client,identity);const c=createAuthController(createSupabaseAuthApi(client as unknown as SupabaseClient));await c.start();await expect(c.signOut()).rejects.toThrow('local_logout_failed');expect(cleanup).toBe(1);expect(c.getState()).toMatchObject({phase:'signedOut',error:'local_logout_failed'});expect(await identity.locked()).toBe(true);c.dispose();
});
