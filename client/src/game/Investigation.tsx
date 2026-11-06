import { useEffect,useId,useRef,useState } from 'react';
import type { InvestigationDay,InvestigationSubmission,InvestigationView } from '../../../shared/investigations';
import './investigation.css';

const MAX_ANSWER_LENGTH=4000;
const POLL_DELAY_MS=1800;
type Action='answer'|'skip';
type JsonPayload=Record<string,unknown>|InvestigationView|null;

class InvestigationHttpError extends Error {
  retryable:boolean;
  constructor(message:string,retryable=false){super(message);this.name='InvestigationHttpError';this.retryable=retryable;}
}

function payloadMessage(payload:JsonPayload){return payload&&typeof payload==='object'&&'error' in payload&&typeof payload.error==='string'?payload.error:null;}
function httpError(status:number,payload:JsonPayload){
  const serverMessage=payloadMessage(payload);
  if(serverMessage)return new InvestigationHttpError(`${serverMessage} (HTTP ${status}).`,status===429||status>=500);
  if(status===401)return new InvestigationHttpError('Sign in required to submit an investigation.');
  if(status===403)return new InvestigationHttpError('You are not allowed to investigate this day.');
  if(status===404)return new InvestigationHttpError('That investigation day is not available.');
  if(status===409)return new InvestigationHttpError('This day already has a first submission. Refresh to view it.');
  if(status===429)return new InvestigationHttpError('Too many investigation requests. Please wait and retry the same answer.',true);
  if(status>=500)return new InvestigationHttpError(`The investigation service is unavailable (HTTP ${status}).`,true);
  return new InvestigationHttpError(`The investigation request was rejected (HTTP ${status}).`);
}

async function readPayload(response:Response):Promise<JsonPayload>{
  try{return await response.json() as JsonPayload;}catch{return null;}
}
function isFinalSubmission(submission:InvestigationSubmission|null|undefined){return submission?.status==='submitted'||submission?.status==='skipped';}
function isPendingView(view:InvestigationView|null){return view?.status==='pending'||view?.own?.status==='pending';}
function percent(accuracy:number){return `${(accuracy<=1?accuracy*100:accuracy).toFixed(0)}%`;}
function sourceLabel(source:'local'|'network'){return source==='local'?'Local evaluation':'Network evaluation';}

export function Investigation({currentDay,initialDay}:{currentDay:number;initialDay?:number}){
  const inputId=useId();
  const [days,setDays]=useState<InvestigationDay[]>([]);
  const [selectedDay,setSelectedDay]=useState<number|null>(null);
  const [daysLoading,setDaysLoading]=useState(true);
  const [daysError,setDaysError]=useState<string|null>(null);
  const [view,setView]=useState<InvestigationView|null>(null);
  const [answer,setAnswer]=useState('');
  const [loading,setLoading]=useState(false);
  const [requestBusy,setRequestBusy]=useState(false);
  const [pendingHintDay,setPendingHintDay]=useState<number|null>(null);
  const [error,setError]=useState<string|null>(null);
  const [retrySubmission,setRetrySubmission]=useState(false);
  const [refreshToken,setRefreshToken]=useState(0);
  const selectedDayRef=useRef<number|null>(selectedDay);
  const lockedAnswers=useRef<Record<number,string>>({});
  const actions=useRef<Record<number,Action|undefined>>({});
  const postRef=useRef<{day:number;controller:AbortController}|null>(null);
  const pollTimer=useRef<ReturnType<typeof setTimeout>|null>(null);
  const previousInitialDay=useRef(initialDay);
  selectedDayRef.current=selectedDay;

  const eligibleDays=days.filter(day=>day.day<currentDay).sort((a,b)=>b.day-a.day);
  const currentViewDay=selectedDay===null?null:view?.day===selectedDay?view:null;
  const own=currentViewDay?.own??null;
  const pending=pendingHintDay===selectedDay||isPendingView(currentViewDay);
  const finalized=isFinalSubmission(own)||currentViewDay?.status==='submitted'||currentViewDay?.status==='skipped';
  const lockedAnswer=selectedDay===null?undefined:lockedAnswers.current[selectedDay];
  const action=selectedDay===null?undefined:actions.current[selectedDay];
  const submitDisabled=loading||!currentViewDay||requestBusy||pending||finalized||action==='skip'||(lockedAnswer!==undefined&&!retrySubmission);
  const editingDisabled=loading||!currentViewDay||requestBusy||pending||finalized||action==='skip'||lockedAnswer!==undefined;
  const displayedAnswer=lockedAnswer??answer;

  function cancelPoll(){if(pollTimer.current!==null){clearTimeout(pollTimer.current);pollTimer.current=null;}}
  function schedulePoll(day:number){
    cancelPoll();
    pollTimer.current=setTimeout(()=>{pollTimer.current=null;if(selectedDayRef.current===day)setRefreshToken(token=>token+1);},POLL_DELAY_MS);
  }
  function acceptView(day:number,next:InvestigationView){
    if(selectedDayRef.current!==day)return;
    setView(next);
    const submission=next.own;
    if(submission&&(submission.status==='pending'||submission.status==='submitted')&&typeof submission.answer==='string'){
      lockedAnswers.current[day]=submission.answer;
      setAnswer(submission.answer);
      actions.current[day]='answer';
    }else if(submission?.status==='skipped'){
      actions.current[day]='skip';
    }
    setPendingHintDay(isPendingView(next)?day:null);
  }

  useEffect(()=>{
    const controller=new AbortController();
    setDaysLoading(true);setDaysError(null);
    void fetch('/api/investigations',{credentials:'same-origin',signal:controller.signal}).then(async response=>{
      const payload=await readPayload(response);
      if(!response.ok)throw httpError(response.status,payload);
      if(!payload||typeof payload!=='object'||!Array.isArray((payload as {days?:unknown}).days))throw new Error('Investigation days were unavailable.');
      return (payload as {days:InvestigationDay[]}).days;
    }).then(nextDays=>{
      if(controller.signal.aborted)return;
      setDays(nextDays);
      const eligible=nextDays.filter(day=>day.day<currentDay).sort((a,b)=>b.day-a.day);
      const requested=initialDay!==undefined&&Number.isInteger(initialDay)&&initialDay>=1&&initialDay<currentDay&&eligible.some(day=>day.day===initialDay)?initialDay:null;
      setSelectedDay(previous=>requested??(previous!==null&&eligible.some(day=>day.day===previous)?previous:eligible[0]?.day??null));
      setDaysLoading(false);
    }).catch(reason=>{if(!controller.signal.aborted){setDaysError(reason instanceof Error?reason.message:'Investigation days were unavailable.');setDaysLoading(false);}});
    return()=>controller.abort();
  },[currentDay]);

  useEffect(()=>{
    if(selectedDay===null){
      cancelPoll();
      postRef.current?.controller.abort();postRef.current=null;
      setView(null);setAnswer('');setLoading(false);setRequestBusy(false);setPendingHintDay(null);setError(null);setRetrySubmission(false);
      return;
    }
    const day=selectedDay;
    const controller=new AbortController();
    cancelPoll();
    postRef.current?.controller.abort();postRef.current=null;
    setView(null);setLoading(true);setRequestBusy(false);setPendingHintDay(null);setError(null);setRetrySubmission(false);
    setAnswer(lockedAnswers.current[day]??'');
    void fetch(`/api/investigations/${day}`,{credentials:'same-origin',signal:controller.signal}).then(async response=>{
      const payload=await readPayload(response);
      if(!response.ok)throw httpError(response.status,payload);
      if(!payload||typeof payload!=='object'||typeof (payload as {day?:unknown}).day!=='number')throw new Error('Investigation details were unavailable.');
      return {payload:payload as InvestigationView,serverPending:response.status===202};
    }).then(({payload,serverPending})=>{
      if(controller.signal.aborted)return;
      acceptView(day,payload);setLoading(false);
      if(serverPending||isPendingView(payload))schedulePoll(day);
    }).catch(reason=>{if(!controller.signal.aborted){setLoading(false);setError(reason instanceof Error?reason.message:'Investigation details were unavailable.');}});
    return()=>{controller.abort();cancelPoll();};
  },[selectedDay,currentDay,refreshToken]);

  useEffect(()=>{
    if(initialDay!==undefined&&previousInitialDay.current!==initialDay&&Number.isInteger(initialDay)&&initialDay>=1&&initialDay<currentDay&&days.some(day=>day.day===initialDay))setSelectedDay(initialDay);
    previousInitialDay.current=initialDay;
  },[currentDay,days,initialDay]);

  async function submitAnswer(){
    const day=selectedDay;
    if(day===null||requestBusy||pending||finalized||action==='skip')return;
    const text=lockedAnswers.current[day]??answer.trim();
    if(!text)return;
    if(text.length>MAX_ANSWER_LENGTH)return;
    lockedAnswers.current[day]=text;actions.current[day]='answer';setAnswer(text);setRequestBusy(true);setError(null);setRetrySubmission(false);
    const controller=new AbortController();postRef.current={day,controller};
    try{
      const response=await fetch(`/api/investigations/${day}`,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:JSON.stringify({answer:text}),signal:controller.signal});
      const payload=await readPayload(response);
      if(!response.ok)throw httpError(response.status,payload);
      if(!payload||typeof payload!=='object'||typeof (payload as {day?:unknown}).day!=='number'){
        if(response.status===202){setPendingHintDay(day);setError('Your answer is pending evaluation. It remains locked; retry the same answer if this response was lost.');schedulePoll(day);return;}
        throw new Error('The investigation response was incomplete.');
      }
      if(selectedDayRef.current!==day)return;
      acceptView(day,payload as InvestigationView);
      if(response.status===202||isPendingView(payload as InvestigationView)){setError('Your answer is pending evaluation. It remains locked while the result is prepared.');schedulePoll(day);}else setRetrySubmission(false);
    }catch(reason){
      if(controller.signal.aborted)return;
      if(reason instanceof InvestigationHttpError&&!reason.retryable){delete lockedAnswers.current[day];delete actions.current[day];setRetrySubmission(false);}
      else {setRetrySubmission(true);setError('The response was lost. Retry the same answer; it will not be replaced.');}
      if(reason instanceof InvestigationHttpError&&!reason.retryable)setError(reason.message);
      else if(!(reason instanceof InvestigationHttpError))setError('The response was lost. Retry the same answer; it will not be replaced.');
    }finally{if(postRef.current?.controller===controller){postRef.current=null;setRequestBusy(false);}}
  }

  async function skipInvestigation(){
    const day=selectedDay;
    if(day===null||requestBusy||pending||finalized||action==='skip'||lockedAnswer!==undefined)return;
    actions.current[day]='skip';setRequestBusy(true);setError(null);setRetrySubmission(false);
    const controller=new AbortController();postRef.current={day,controller};
    try{
      const response=await fetch(`/api/investigations/${day}/skip`,{method:'POST',credentials:'same-origin',headers:{'Content-Type':'application/json'},body:'{}',signal:controller.signal});
      const payload=await readPayload(response);
      if(!response.ok)throw httpError(response.status,payload);
      if(!payload||typeof payload!=='object'||typeof (payload as {day?:unknown}).day!=='number')throw new Error('The skip response was incomplete.');
      if(selectedDayRef.current!==day)return;
      acceptView(day,payload as InvestigationView);
      if(response.status===202||isPendingView(payload as InvestigationView)){setError('Your skip is pending. No reward will be awarded; checking for confirmation.');schedulePoll(day);}
    }catch(reason){
      if(controller.signal.aborted)return;
      delete actions.current[day];
      setError(reason instanceof InvestigationHttpError?reason.message:'The skip response was lost. Retry skip to confirm; it awards zero influence.');
    }finally{if(postRef.current?.controller===controller){postRef.current=null;setRequestBusy(false);}}
  }

  const finalOthers=finalized?(currentViewDay?.others??[]).filter(other=>other.answer.trim()&&other.result!==null):[];
  return <section className="investigation">
    <header className="investigation-header"><div><h2>Case Investigation</h2><p>Review a closed day without claiming perfect certainty.</p></div><label htmlFor={`${inputId}-day`}>Closed day<select id={`${inputId}-day`} value={selectedDay??''} disabled={daysLoading||!eligibleDays.length||requestBusy} onChange={event=>setSelectedDay(event.target.value?Number(event.target.value):null)}><option value="">Choose a day</option>{eligibleDays.map(day=><option key={day.day} value={day.day}>Day {day.day}</option>)}</select></label></header>
    {daysError?<p role="alert">{daysError}</p>:null}
    {!daysLoading&&!eligibleDays.length?<p className="investigation-empty">No closed days are available yet. On Day 1, there is nothing to investigate; return after another day closes.</p>:null}
    {selectedDay!==null?<div className="investigation-body" aria-live="polite">
      {loading?<p>Loading Day {selectedDay} investigation…</p>:null}
      {error?<p role="alert">{error}</p>:null}
      {pending&&!loading?<p className="investigation-pending">Evaluation pending. Your first answer is locked while the town checks it.</p>:null}
      {currentViewDay&&!loading?<>
        {own?.answer?<article className="investigation-own-answer"><small>Your inquiry</small><p>{own.answer}</p></article>:null}
        {own?.result?<section className="investigation-score" aria-label="Your investigation score"><h3>Your result</h3><dl><div><dt>Events matched</dt><dd>{own.result.correctEvents}/{own.result.totalEvents}</dd></div><div><dt>Accuracy</dt><dd>{percent(own.result.accuracy)}</dd></div><div><dt>Influence awarded</dt><dd>{own.result.influenceAwarded}</dd></div><div><dt>Source</dt><dd>{sourceLabel(own.result.source)}</dd></div></dl><p className="investigation-note">This score reflects the evaluated events available to the town, not perfect certainty.</p></section>:null}
        {own?.status==='skipped'?<p className="investigation-note">You skipped this day. Influence awarded: 0.</p>:null}
        {finalOthers.length?<section className="investigation-others"><h3>Other finalized inquiries</h3>{finalOthers.map(other=><article key={other.playerId}><small>{other.username}</small><p>{other.answer}</p></article>)}</section>:null}
      </>:null}
    </div>:null}
    {selectedDay!==null&&!finalized?<form className="investigation-form" onSubmit={event=>{event.preventDefault();void submitAnswer();}}><label htmlFor={inputId}>What happened? Name people/actions/place/EGP amount if known</label><textarea id={inputId} value={displayedAnswer} onChange={event=>setAnswer(event.target.value)} maxLength={MAX_ANSWER_LENGTH} rows={5} disabled={editingDisabled} placeholder="What happened? Name people, actions, place, or an EGP amount if known."/><small className="investigation-count">{displayedAnswer.length}/{MAX_ANSWER_LENGTH}</small><div className="investigation-actions"><button type="submit" disabled={submitDisabled||!displayedAnswer.trim()}>{requestBusy?'Submitting…':retrySubmission?'Retry submission':'Submit'}</button><button type="button" onClick={()=>void skipInvestigation()} disabled={editingDisabled}>Skip</button></div><p className="investigation-skip-note">Skip awards 0 influence and cannot be undone.</p></form>:null}
  </section>;
}
