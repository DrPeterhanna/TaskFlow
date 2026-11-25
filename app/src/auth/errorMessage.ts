import type {AuthErrorCode} from './authController';
import {strings,type Locale} from '../i18n';

/** Copy only: never changes authentication, network retries or authorization. */
export function authErrorMessage(code:AuthErrorCode|null,locale:Locale,env:{name?:string;url?:string}):string|null{
 if(!code)return null;
 const t=strings(locale).auth;
 if(code==='network'&&env.name==='local'){
  try{
   const target=new URL(env.url??'');
   if(['http:','https:'].includes(target.protocol)&&['localhost','127.0.0.1','10.0.2.2'].includes(target.hostname))return t.localConnection;
  }catch{/* invalid configuration uses the ordinary error, not a misleading local diagnosis */}
 }
 return t.errors[code];
}
