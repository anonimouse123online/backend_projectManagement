'use strict';
const {calendar}=require('./cpmSchedulingService');
function assessRisk(schedule,options={}){
 const cal=calendar(options.weekdays,options.holidays);const asOf=options.asOf?new Date(`${options.asOf}T00:00:00Z`):new Date();const byId=new Map(schedule.tasks.map(t=>[t.id,t]));const baselineById=new Map((options.baselineTasks||[]).map(t=>[t.task_id,t]));const baselineDate=options.baselineCreatedAt?new Date(options.baselineCreatedAt):null;const risks=schedule.tasks.map(task=>{
  if(['completed','complete','done'].includes(String(task.status||'').toLowerCase()))return {...task,risk:'LOW',score:0,reasons:['Activity is complete.']};
  let score=0;const reasons=[];
  if(task.critical){score+=35;reasons.push('Activity is on the current critical path.');}
  if(task.warnings?.length){score+=30;reasons.push('Activity has unresolved schedule constraints.');}
  if(schedule.constraints?.some(c=>!c.taskId)){score+=30;reasons.push('Project-level schedule constraint, including approved completion date, is unresolved.');}
  if((schedule.dependencies||[]).some(edge=>edge.successorTaskId===task.id&&((byId.get(edge.predecessorTaskId)?.totalFloat??1)<=0||byId.get(edge.predecessorTaskId)?.warnings?.length))){score+=10;reasons.push('A predecessor is critical or has an unresolved schedule constraint.');}
  if(task.totalFloat<0){score+=30;reasons.push(`${Math.abs(task.totalFloat)} working day(s) of negative float against the approved completion date.`);}
  else if(task.totalFloat===0){score+=20;reasons.push('No working-day float remains.');}
  else if(task.totalFloat<=2){score+=15;reasons.push(`Only ${task.totalFloat} working day(s) of float remain.`);}
  else if(task.totalFloat<=5){score+=8;reasons.push(`${task.totalFloat} working days of float remain.`);}
  const start=new Date(`${task.startDate}T00:00:00Z`);if(task.progress<100&&start<asOf){score+=20;reasons.push('Forecast start is before the assessment date while progress is incomplete.');}
  const daysToFinish=Math.ceil((new Date(`${task.endDate}T00:00:00Z`)-asOf)/86400000);if(task.progress<100&&daysToFinish>=0&&daysToFinish<=5){score+=10;reasons.push('Forecast finish is within five calendar days while progress is incomplete.');}
  const baseline=baselineById.get(task.id);if(baseline&&baselineDate&&baseline.duration_days>0&&Number.isFinite(baseline.progress_pct)&&asOf>=baselineDate){const remaining=Math.max(0,100-baseline.progress_pct);const elapsed=Math.max(0,cal.distance(baselineDate,asOf));const expected=Math.min(100,baseline.progress_pct+remaining*Math.min(1,elapsed/baseline.duration_days));if(task.progress+5<expected){score+=10;reasons.push(`Actual progress ${task.progress}% trails baseline-expected progress ${Math.round(expected)}%.`);}}
  const band=score>=70?'CRITICAL':score>=50?'HIGH':score>=25?'MODERATE':'LOW';return {...task,risk:band,score,reasons};
 });
 const rank={LOW:0,MODERATE:1,HIGH:2,CRITICAL:3};const overall=risks.reduce((a,x)=>rank[x.risk]>rank[a]?x.risk:a,'LOW');return {method:'Deterministic additive score: critical path +35; unresolved task/project constraints +30; negative float +30; zero float +20; float 1-2 days +15; float 3-5 days +8; overdue incomplete start +20; critical/blocked predecessor +10; forecast finish within five calendar days while incomplete +10; progress trailing available baseline plan by over five percentage points +10. Bands: <25 LOW, 25-49 MODERATE, 50-69 HIGH, 70+ CRITICAL.',overall,activities:risks};
}
module.exports={assessRisk};
