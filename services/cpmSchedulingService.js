'use strict';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
class SchedulingError extends Error { constructor(message) { super(message); this.status = 400; } }
function asDate(value) {
  if (!value) return null;
  const text = value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
  if (!DATE_RE.test(text)) return null;
  const date = new Date(`${text}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === text ? date : null;
}
const str = d => d.toISOString().slice(0, 10);
function calendar(weekdays = [1, 2, 3, 4, 5], holidays = []) {
  const workdays = new Set(weekdays); const off = new Set(holidays.map(x => String(x).slice(0, 10)));
  const isWork = d => workdays.has(d.getUTCDay()) && !off.has(str(d));
  function shift(d, amount) {
    const out = new Date(d); const direction = amount < 0 ? -1 : 1;
    for (let left = Math.abs(amount); left;) { out.setUTCDate(out.getUTCDate() + direction); if (isWork(out)) left--; }
    return out;
  }
  function normalize(d) { const out = new Date(d); while (!isWork(out)) out.setUTCDate(out.getUTCDate() + 1); return out; }
  function distance(a, b) {
    let count = 0; const dir = a <= b ? 1 : -1; const d = new Date(a);
    while (str(d) !== str(b)) { d.setUTCDate(d.getUTCDate() + dir); if (isWork(d)) count += dir; }
    return count;
  }
  return { isWork, shift, normalize, distance };
}
function calculateSchedule(input) {
  const cal = calendar(input.weekdays, input.holidays);
  const tasks = (input.tasks || []).map(t => {
    const start=asDate(t.startDate ?? t.start_date), finish=asDate(t.endDate ?? t.due_date);
    const supplied=t.duration ?? t.estimated_duration_days;
    const derived=supplied==null&&start&&finish?cal.distance(start,finish)+1:null;
    return {...t,id:String(t.id),duration:Math.max(1,Number(supplied??derived??1)),recordedDuration:t.recordedDuration!==undefined?t.recordedDuration:(supplied==null?null:Number(supplied)),durationAssumed:t.durationAssumed!==undefined?t.durationAssumed:(supplied==null&&derived==null),start,finish};
  });
  const ids = new Set(tasks.map(t => t.id));
  const edges = (input.dependencies || []).map(d => ({ from: String(d.predecessorTaskId ?? d.predecessor_task_id), to: String(d.successorTaskId ?? d.task_id),
    type: String(d.type ?? d.dependency_type ?? 'FS').toUpperCase(), lag: Number(d.lag ?? d.lag_working_days ?? 0) }));
  const edgeKeys=new Set();for(const e of edges){const key=`${e.from}:${e.to}`;if(edgeKeys.has(key))throw new SchedulingError('Duplicate task dependency relationship.');edgeKeys.add(key);}
  const byId = new Map(tasks.map(t => [t.id, t])); const outgoing = new Map(tasks.map(t => [t.id, []])); const indegree = new Map(tasks.map(t => [t.id, 0]));
  for (const e of edges) {
    if (!ids.has(e.from) || !ids.has(e.to)) throw new SchedulingError('Dependency references a task outside this project.');
    if (e.from === e.to) throw new SchedulingError('A task cannot depend on itself.');
    if (!['FS', 'SS', 'FF', 'SF'].includes(e.type) || !Number.isInteger(e.lag)) throw new SchedulingError('Dependency type or working-day lag is invalid.');
    outgoing.get(e.from).push(e); indegree.set(e.to, indegree.get(e.to) + 1);
  }
  const queue = tasks.filter(t => indegree.get(t.id) === 0).sort((a,b) => a.id.localeCompare(b.id)); const order = [];
  while (queue.length) { const t=queue.shift(); order.push(t); for (const e of outgoing.get(t.id)) { indegree.set(e.to, indegree.get(e.to)-1); if (!indegree.get(e.to)) { queue.push(byId.get(e.to)); queue.sort((a,b)=>a.id.localeCompare(b.id)); } } }
  if (order.length !== tasks.length) throw new SchedulingError('Dependency graph contains a cycle.');
  const plan = new Map(); const constraints=[];
  for (const t of order) {
    const duration = t.duration; let start = t.start ? cal.normalize(t.start) : null;
    for (const e of edges.filter(x => x.to === t.id)) {
      const pred=plan.get(e.from); if (!pred) continue;
      const predStart=pred.es, predFinish=pred.ef; let bound;
      if (e.type === 'FS') bound=cal.shift(predFinish,e.lag+1);
      if (e.type === 'SS') bound=cal.shift(predStart,e.lag);
      if (e.type === 'FF') bound=cal.shift(predFinish,e.lag-duration+1);
      if (e.type === 'SF') bound=cal.shift(predStart,e.lag-duration+1);
      if (!start || bound > start) start=bound;
    }
    if (!start){const anchor=asDate(input.projectStart);if(!anchor)throw new SchedulingError(`Insufficient schedule data for task ${t.id}: provide a project start date or an explicit task start date.`);start=cal.normalize(anchor);}
    if(asDate(input.projectStart)&&start<cal.normalize(asDate(input.projectStart))){constraints.push({taskId:t.id,message:`Task starts before the project start date ${input.projectStart}.`});start=cal.normalize(asDate(input.projectStart));}
    let finish=cal.shift(start,duration-1);
    const fixed=t.status && ['completed','complete','done'].includes(String(t.status).toLowerCase());
    if (fixed && t.finish && t.start) { start=cal.normalize(t.start); finish=t.finish; }
    if (t.finish && finish > t.finish && !fixed) constraints.push({taskId:t.id, message:`Dependency forecast ${str(finish)} exceeds the task's explicit end date ${str(t.finish)}.`});
    plan.set(t.id,{ es:start, ef:finish, duration, task:t });
  }
  const projectFinish = order.length ? new Date(Math.max(...order.map(t=>plan.get(t.id).ef.getTime()))) : null;
  function backward(deadline) {
    const late=new Map();
    for (const t of [...order].reverse()) {
      const p=plan.get(t.id); let lf=deadline;
      for (const e of outgoing.get(t.id)) {
        const succ=late.get(e.to); if (!succ) continue;
        let candidate;
        if(e.type==='FS') candidate=cal.shift(succ.ls,-e.lag-1);
        if(e.type==='SS') candidate=cal.shift(succ.ls,-e.lag+p.duration-1);
        if(e.type==='FF') candidate=cal.shift(succ.lf,-e.lag+p.duration-1);
        if(e.type==='SF') candidate=cal.shift(succ.lf,-e.lag+p.duration-1);
        if(candidate < lf) lf=candidate;
      }
      const ls=cal.shift(lf,-(p.duration-1)); late.set(t.id,{ls,lf});
    }
    return late;
  }
  const networkLate=projectFinish?backward(projectFinish):new Map();
  const deadline=asDate(input.projectEnd);const deadlineLate=deadline?backward(deadline):null;
  const result=tasks.map(t=>{const p=plan.get(t.id), nl=networkLate.get(t.id), dl=deadlineLate?.get(t.id); const networkFloat=nl?cal.distance(p.es,nl.ls):null; const deadlineBuffer=dl?cal.distance(p.es,dl.ls):null; return {id:t.id,name:t.task_name||t.name||'',assigneeId:t.assignee_id||null,startDate:str(p.es),endDate:str(p.ef),recordedStartDate:t.start?str(t.start):null,recordedEndDate:t.finish?str(t.finish):null,duration:p.duration,recordedDuration:t.recordedDuration,status:t.status||null,progress:Number(t.progress_pct??t.progress??0),networkTotalFloat:networkFloat,deadlineBuffer,totalFloat:networkFloat,critical:networkFloat!==null&&networkFloat<=0,warnings:constraints.filter(c=>c.taskId===t.id).map(c=>c.message)};});
  if(asDate(input.projectEnd)&&projectFinish>asDate(input.projectEnd))constraints.push({taskId:null,message:`Forecast completion ${str(projectFinish)} exceeds approved project completion ${input.projectEnd}; deadline approval is required.`});
  return {tasks:result, completionDate:projectFinish?str(projectFinish):null, approvedTargetCompletion:input.projectEnd||null,deadlineVarianceWorkingDays:deadline&&projectFinish?cal.distance(deadline,projectFinish):null, projectStart:input.projectStart||null,projectEnd:input.projectEnd||null,weekdays:[...(input.weekdays||[1,2,3,4,5])],calendarVersion:input.calendarVersion||1,criticalPath:result.filter(t=>t.critical).map(t=>t.id), dependencies:edges.map(e=>({predecessorTaskId:e.from,successorTaskId:e.to,type:e.type,lag:e.lag})),holidays:[...new Set(input.holidays||[])].sort(),constraints, warnings:[...tasks.filter(t=>!t.start||!t.finish).map(t=>({code:'TASK_DATES_INCOMPLETE',taskId:t.id,message:'Original task dates are incomplete; forecast dates are calculated from dependencies and project start.'})),...tasks.filter(t=>t.durationAssumed).map(t=>({code:'TASK_DURATION_ASSUMED',taskId:t.id,message:'Duration is unknown; forecast assumes one working day.'}))]};
}
function simulate(input, changes = []) {
  const original=calculateSchedule(input); const durationById=new Map(original.tasks.map(t=>[t.id,t]));const tasks=input.tasks.map(t=>{const previous=durationById.get(String(t.id));return {...t,estimated_duration_days:t.estimated_duration_days??t.duration??previous?.duration,recordedDuration:previous?.recordedDuration,durationAssumed:original.warnings.some(w=>w.taskId===String(t.id)&&w.message.includes('Duration is unknown'))};});
  let dependencies=(input.dependencies||[]).map(e=>({...e})); const holidays=[...(input.holidays||[])]; const resourceResults=[];
  for (const c of changes) {
    const operation=String(c.operation||'').toLowerCase();
    if(operation==='add_dependency'||c.addDependency){const d=c.dependency||c.addDependency;dependencies.push({predecessor_task_id:d.predecessorTaskId??d.predecessor_task_id,task_id:d.successorTaskId??d.successor_task_id,dependency_type:d.type??d.dependency_type??'FS',lag_working_days:d.lag??d.lag_working_days??0});continue;}
    if(operation==='remove_dependency'||c.removeDependency){const d=c.dependency||c.removeDependency;const before=dependencies.length;dependencies=dependencies.filter(x=>!(String(x.predecessor_task_id??x.predecessorTaskId)===String(d.predecessorTaskId??d.predecessor_task_id)&&String(x.task_id??x.successorTaskId)===String(d.successorTaskId??d.successor_task_id)));if(dependencies.length===before)throw new SchedulingError('Cannot remove a dependency that does not exist in this project.');continue;}
    if(Array.isArray(c.nonworkingDates)){for(const day of c.nonworkingDates){if(!asDate(day))throw new SchedulingError('Weather/nonworking dates must use valid YYYY-MM-DD values.');holidays.push(day);}}
    if(operation==='weather_interruption'&&Array.isArray(c.nonworkingDates))continue;
    const t=tasks.find(x=>String(x.id)===String(c.taskId)); if(!t) throw new SchedulingError(`Task ${c.taskId} does not belong to this project.`); if(['completed','complete','done'].includes(String(t.status||'').toLowerCase()))throw new SchedulingError(`Completed task ${c.taskId} cannot be rescheduled.`);
    if(c.startDate !== undefined) {if(!asDate(c.startDate))throw new SchedulingError('startDate must be a valid YYYY-MM-DD date.');t.start_date=c.startDate;}
    if(c.endDate !== undefined) {if(!asDate(c.endDate))throw new SchedulingError('endDate must be a valid YYYY-MM-DD date.');t.due_date=c.endDate;}
    if(c.startDate !== undefined && c.endDate !== undefined) {
      const proposedStart=asDate(c.startDate), proposedFinish=asDate(c.endDate);
      if(proposedFinish<proposedStart)throw new SchedulingError('endDate must be on or after startDate.');
      const cal=calendar(input.weekdays,input.holidays); const derived=Math.max(1,cal.distance(proposedStart,proposedFinish)+1);
      if(c.duration!==undefined&&Number(c.duration)!==derived)throw new SchedulingError('The supplied duration conflicts with the proposed startDate/endDate range.');
      t.estimated_duration_days=derived;t.recordedDuration=derived;t.durationAssumed=false;
    } else if(c.endDate !== undefined) {
      const start=asDate(c.startDate??t.start_date) || asDate(original.tasks.find(x=>x.id===String(t.id))?.startDate);
      if(start){const finish=asDate(c.endDate);if(finish<start)throw new SchedulingError('endDate must be on or after the task start date.');const cal=calendar(input.weekdays,input.holidays);const derived=Math.max(1,cal.distance(start,finish)+1);if(c.duration!==undefined&&Number(c.duration)!==derived)throw new SchedulingError('The supplied duration conflicts with the proposed endDate.');t.estimated_duration_days=derived;t.recordedDuration=derived;t.durationAssumed=false;}
    }
    if(c.duration !== undefined) { if(!Number.isInteger(Number(c.duration))||Number(c.duration)<1) throw new SchedulingError('duration must be a positive whole number.'); if(!(c.startDate!==undefined&&c.endDate!==undefined)&&c.endDate===undefined){t.estimated_duration_days=Number(c.duration);t.recordedDuration=Number(c.duration);t.durationAssumed=false;} }
    const a=c.resourceAssumptions||c.productivityAssumption;
    if(a){const currentWorkers=Number(a.currentWorkers),proposedWorkers=Number(a.proposedWorkers),currentRate=Number(a.currentTeamOutputPerDay),proposedRate=Number(a.proposedTeamOutputPerDay),quantity=Number(a.remainingQuantity);if(!(currentWorkers>0&&proposedWorkers>0&&currentRate>0&&proposedRate>0&&quantity>0))throw new SchedulingError('Manpower simulation requires positive crew counts, remainingQuantity, currentTeamOutputPerDay, and proposedTeamOutputPerDay. Supply measured team productivity; worker counts alone do not change duration.');const currentDuration=Math.max(1,Math.ceil(quantity/currentRate));const newDuration=Math.max(1,Math.ceil(quantity/proposedRate));t.estimated_duration_days=newDuration;t.recordedDuration=newDuration;t.durationAssumed=false;const extraWorkers=Math.max(0,proposedWorkers-currentWorkers);const cost=a.laborCostPerWorkerDay!=null&&Number.isFinite(Number(a.laborCostPerWorkerDay))?extraWorkers*newDuration*Number(a.laborCostPerWorkerDay):null;resourceResults.push({taskId:t.id,type:'MANPOWER_CHANGE',currentWorkers,proposedWorkers,currentTeamOutputPerDay:currentRate,proposedTeamOutputPerDay:proposedRate,originalDuration:currentDuration,simulatedDuration:newDuration,recoveredWorkingDays:Math.max(0,currentDuration-newDuration),estimatedAdditionalCost:cost,currency:a.currency||null,costStatus:cost==null?'not_calculated':'calculated',assumption:'Remaining quantity divided by user-supplied aggregate team output per working day; no worker-count scaling is inferred.'});}
    if(c.overtimeAssumptions){const o=c.overtimeAssumptions;const remaining=Number(o.remainingEffortHours),baseHours=Number(o.baseProductiveHoursPerDay),extra=Number(o.extraProductiveHoursPerDay),days=Number(o.overtimeDays);if(!(remaining>0&&baseHours>0&&extra>0&&days>0))throw new SchedulingError('Overtime simulations require positive remainingEffortHours, baseProductiveHoursPerDay, extraProductiveHoursPerDay, and overtimeDays.');const baseDuration=Math.ceil(remaining/baseHours);const overtimeDuration=Math.max(1,Math.ceil(remaining/(baseHours+extra)));if(days<baseDuration-overtimeDuration)throw new SchedulingError('overtimeDays does not support the proposed recovery under the supplied hour assumptions.');t.estimated_duration_days=overtimeDuration;t.recordedDuration=overtimeDuration;t.durationAssumed=false;const cost=o.overtimeCostPerHour!=null&&Number.isFinite(Number(o.overtimeCostPerHour))?extra*days*Number(o.overtimeCostPerHour):null;resourceResults.push({taskId:t.id,type:'OVERTIME',originalDuration:baseDuration,simulatedDuration:overtimeDuration,recoveredWorkingDays:baseDuration-overtimeDuration,estimatedAdditionalCost:cost,currency:o.currency||null,costStatus:cost==null?'not_calculated':'calculated',assumption:'Remaining effort divided by explicitly supplied productive hours per working day.'});}
    if(c.blockUntilDate){if(!asDate(c.blockUntilDate))throw new SchedulingError('blockUntilDate must be a valid YYYY-MM-DD date.');t.start_date=c.blockUntilDate;}
    if(c.delayWorkingDays !== undefined) { if(!Number.isInteger(Number(c.delayWorkingDays))) throw new SchedulingError('delayWorkingDays must be a whole number.'); const cal=calendar(input.weekdays,input.holidays); const current=asDate(t.start_date)||asDate(input.projectStart); if(!current) throw new SchedulingError('Cannot apply a delay when task and project start dates are missing.'); t.start_date=str(cal.shift(current,Number(c.delayWorkingDays))); }
  }
  const proposed=calculateSchedule({...input,tasks,dependencies,holidays:[...new Set(holidays)]}); const oldBy=new Map(original.tasks.map(t=>[t.id,t]));
  const affected=proposed.tasks.filter(t=>oldBy.get(t.id).startDate!==t.startDate||oldBy.get(t.id).endDate!==t.endDate||oldBy.get(t.id).duration!==t.duration||changes.some(c=>String(c.taskId)===t.id)).map(t=>({...t,previousStartDate:oldBy.get(t.id).startDate,previousEndDate:oldBy.get(t.id).endDate,previousRecordedStartDate:oldBy.get(t.id).recordedStartDate,previousRecordedEndDate:oldBy.get(t.id).recordedEndDate,previousDuration:oldBy.get(t.id).duration,reason:changes.some(c=>String(c.taskId)===t.id)?'Directly changed':'Shifted by dependency constraints'}));
  const affectedIds=new Set(affected.map(t=>t.id));for(const task of proposed.tasks)if(affectedIds.has(task.id)){task.recordedStartDate=task.startDate;task.recordedEndDate=task.endDate;}
  const cal=calendar(input.weekdays,input.holidays); const diff=original.completionDate&&proposed.completionDate?cal.distance(asDate(original.completionDate),asDate(proposed.completionDate)):null;
  const target=asDate(input.projectEnd);const deadlineVariance=target&&proposed.completionDate?cal.distance(target,asDate(proposed.completionDate)):null;
  const knownCosts=resourceResults.filter(x=>x.estimatedAdditionalCost!=null);const currencies=new Set(knownCosts.map(x=>x.currency));const costAvailable=knownCosts.length===resourceResults.length&&knownCosts.length>0&&currencies.size===1&&![...currencies].includes(null);return {original,proposed,affectedTasks:affected,originalCompletionDate:original.completionDate,forecastCompletionDate:proposed.completionDate,approvedTargetCompletion:input.projectEnd||null,currentForecastCompletion:original.completionDate,simulatedForecastCompletion:proposed.completionDate,scheduleChangeImpactWorkingDays:diff,projectDeadlineVarianceWorkingDays:deadlineVariance,durationDifferenceWorkingDays:diff,costImpact:costAvailable?{status:'calculated',amount:knownCosts.reduce((sum,x)=>sum+x.estimatedAdditionalCost,0),currency:[...currencies][0]}:{status:'not_calculated',amount:null,currency:null},resourceResults,proposedDependencies:proposed.dependencies,proposedHolidays:proposed.holidays,explanations:affected.map(t=>({taskId:t.id,reason:t.reason,previousStartDate:t.previousStartDate,forecastStartDate:t.startDate}))};
}
module.exports={SchedulingError,calendar,calculateSchedule,simulate};
