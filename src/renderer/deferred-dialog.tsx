import React,{lazy,Suspense,useMemo,useRef,useState} from 'react';
import {trap,useFocus} from './dialog-focus';
function LoadingDialog({onClose,message,retry}:{onClose:()=>void;message:string;retry?:()=>void}):React.JSX.Element{
 const ref=useRef<HTMLDivElement|null>(null);useFocus(ref);
 return <div className="collection-backdrop"><div ref={ref} className="collection-dialog deferred-dialog" role="dialog" aria-modal="true" aria-label="打开功能" onKeyDown={e=>trap(e,ref.current,onClose)}><header><h2>{retry?'无法打开功能':'正在打开…'}</h2><button aria-label="关闭" onClick={onClose}>×</button></header><p role={retry?'alert':'status'}>{message}</p><footer>{retry&&<button onClick={retry}>重新尝试</button>}<button onClick={onClose}>关闭</button></footer></div></div>;
}
class DialogBoundary extends React.Component<{children:React.ReactNode;onClose:()=>void;retry:()=>void},{failed:boolean}>{
 state={failed:false};static getDerivedStateFromError(){return {failed:true};}
 render(){return this.state.failed?<LoadingDialog onClose={this.props.onClose} retry={this.props.retry} message="功能未能载入或显示。可重新尝试；若刚执行过保存，请先核对原操作结果。"/>:this.props.children;}
}
export function deferDialog<P extends {onClose:()=>void}>(load:()=>Promise<(props:P)=>React.JSX.Element>):React.ComponentType<P>{
 const factory=()=>load().then(component=>({default:component})),initial=lazy(factory);
 // Defined once at module scope. Only the explicit retry creates a fresh lazy component.
 return function DeferredDialog(props:P):React.JSX.Element{
  const [attempt,setAttempt]=useState(0),Component=useMemo(()=>attempt===0?initial:lazy(factory),[attempt]);
  return <DialogBoundary key={attempt} onClose={props.onClose} retry={()=>setAttempt(value=>value+1)}><Suspense fallback={<LoadingDialog onClose={props.onClose} message="正在读取本地功能组件…"/>}><Component {...props}/></Suspense></DialogBoundary>;
 };
}
