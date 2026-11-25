import { describe, expect, it, vi } from 'vitest';
const { createClient } = vi.hoisted(() => ({createClient:vi.fn((_url: string,_key: string,options: unknown)=>({options}))}));
vi.mock('@supabase/supabase-js',()=>({createClient}));
vi.mock('react-native-url-polyfill/auto',()=>({}));
vi.mock('expo-secure-store',()=>({}));
vi.mock('@react-native-async-storage/async-storage',()=>({default:{}}));
import {createAccountSupabase} from '../src/supabase/client';
import type {SupabaseClient} from '@supabase/supabase-js';

it('account-specific token callback cannot borrow a different users session token', async()=>{
 vi.stubEnv('EXPO_PUBLIC_TASKFLOW_ENV','local'); vi.stubEnv('EXPO_PUBLIC_SUPABASE_URL','http://127.0.0.1:54321'); vi.stubEnv('EXPO_PUBLIC_SUPABASE_KEY','sb_publishable_local_test');
 let session: {user:{id:string};access_token:string}|null={user:{id:'A'},access_token:'synthetic-A'};
 const authClient={auth:{getSession:async()=>({data:{session},error:null})}} as unknown as SupabaseClient;
 createAccountSupabase(authClient,'A');
 const callback=(createClient.mock.calls.at(-1)![2] as {accessToken:()=>Promise<string>}).accessToken;
 await expect(callback()).resolves.toBe('synthetic-A');
 session={user:{id:'B'},access_token:'synthetic-B'}; await expect(callback()).rejects.toThrow('account no longer active');
 session=null; await expect(callback()).rejects.toThrow('account no longer active');
 session={user:{id:'A'},access_token:'synthetic-A-refreshed'}; await expect(callback()).resolves.toBe('synthetic-A-refreshed');
 vi.unstubAllEnvs();
});

it('session retrieval failure fails closed rather than using stale account credentials', async()=>{
 vi.stubEnv('EXPO_PUBLIC_TASKFLOW_ENV','local'); vi.stubEnv('EXPO_PUBLIC_SUPABASE_URL','http://127.0.0.1:54321'); vi.stubEnv('EXPO_PUBLIC_SUPABASE_KEY','sb_publishable_local_test');
 const authClient={auth:{getSession:async()=>({data:{session:{user:{id:'A'},access_token:'synthetic-stale'}},error:Error('revoked')})}} as unknown as SupabaseClient;
 createAccountSupabase(authClient,'A'); const callback=(createClient.mock.calls.at(-1)![2] as {accessToken:()=>Promise<string>}).accessToken;
 await expect(callback()).rejects.toThrow('account no longer active'); vi.unstubAllEnvs();
});
it('a durable or in-memory logout lock blocks otherwise valid matching token before and after session read',async()=>{
 const {registerOfflineIdentity}=await import('../src/auth/offlineIdentity');
 vi.stubEnv('EXPO_PUBLIC_TASKFLOW_ENV','local');vi.stubEnv('EXPO_PUBLIC_SUPABASE_URL','http://127.0.0.1:54321');vi.stubEnv('EXPO_PUBLIC_SUPABASE_KEY','sb_publishable_local_test');
 let locked=true;let reads=0;const authClient={auth:{getSession:async()=>{reads++;locked=true;return {data:{session:{user:{id:'A'},access_token:'synthetic'}},error:null};}}} as unknown as SupabaseClient;
 registerOfflineIdentity(authClient,{locked:async()=>locked,lock:async()=>{locked=true;},unlock:async()=>{locked=false;},read:async()=>null});createAccountSupabase(authClient,'A');const callback=(createClient.mock.calls.at(-1)![2] as {accessToken:()=>Promise<string>}).accessToken;
 await expect(callback()).rejects.toThrow('local identity locked');expect(reads).toBe(0);locked=false;await expect(callback()).rejects.toThrow('local identity locked');expect(reads).toBe(1);vi.unstubAllEnvs();
});
