export const DEFAULT_MORNING_TIME = '06:00';
export const DEFAULT_EVENING_TIME = '18:00';
export const DEFAULT_BEDTIME_TIME = '22:00';
export const DEFAULT_FRIDAY_TIME = '10:00';
export const DEFAULT_TIME_ZONE = 'Asia/Kolkata';
export const PERIODS = ['morning', 'evening', 'bedtime', 'friday'];

export function validateSchedule(time, timeZone) {
  if (!/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    throw new Error('Time must use HH:MM in 24-hour format, for example 06:00.');
  }
  if (typeof timeZone !== 'string' || !timeZone.trim() || timeZone.length > 80) {
    throw new Error('Provide a valid IANA time zone, for example Asia/Kolkata.');
  }
  try { new Intl.DateTimeFormat('en', { timeZone }); }
  catch { throw new Error('Provide a valid IANA time zone, for example Asia/Kolkata.'); }
}

export function validatePeriodSchedule(morningTime, eveningTime, timeZone,
  bedtimeTime = DEFAULT_BEDTIME_TIME, fridayTime = DEFAULT_FRIDAY_TIME) {
  validateSchedule(morningTime, timeZone);
  validateSchedule(eveningTime, timeZone);
  validateSchedule(bedtimeTime, timeZone);
  validateSchedule(fridayTime, timeZone);
  if (morningTime >= '12:00' || eveningTime < '12:00') {
    throw new Error('Morning time must be before 12:00 and evening time must be 12:00 or later.');
  }
  if (bedtimeTime < '18:00') throw new Error('Bedtime must be 18:00 or later.');
  if (fridayTime >= '18:00') throw new Error('The Friday reading reminder must be before 18:00.');
}

export function periodForTime(time) {
  return time < '12:00' ? 'morning' : 'evening';
}

export function localClock(now, timeZone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(now)).map(({ type, value }) => [type, value]));
  return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
}
