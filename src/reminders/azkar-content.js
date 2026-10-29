// Selected morning/evening adhkar, checked against these Sahih narrations on
// 2026-10-28. Arabic prophetic wording is public domain; no generated text.
// This is a short selection, not a complete morning/evening litany.
import { PERIODS } from './clock.js';
const SAYYID_AL_ISTIGHFAR = {
  id: 'bukhari-6306', title: 'سيد الاستغفار',
  text: 'اللَّهُمَّ أَنْتَ رَبِّي لَا إِلَهَ إِلَّا أَنْتَ، خَلَقْتَنِي وَأَنَا عَبْدُكَ، وَأَنَا عَلَى عَهْدِكَ وَوَعْدِكَ مَا اسْتَطَعْتُ، ' +
    'أَعُوذُ بِكَ مِنْ شَرِّ مَا صَنَعْتُ، أَبُوءُ لَكَ بِنِعْمَتِكَ عَلَيَّ وَأَبُوءُ لَكَ بِذَنْبِي، فَاغْفِرْ لِي فَإِنَّهُ لَا يَغْفِرُ الذُّنُوبَ إِلَّا أَنْتَ',
  reference: 'صحيح البخاري (6306)', url: 'https://sunnah.com/bukhari:6306',
};
const TASBIH = {
  id: 'muslim-2692', title: 'التسبيح', text: 'سُبْحَانَ اللَّهِ وَبِحَمْدِهِ', count: 100,
  reference: 'صحيح مسلم (2692)', url: 'https://sunnah.com/muslim:2692',
};

export const MORNING_ADHKAR = [
  {
    id: 'muslim-2723b-morning', title: 'من ذكر الصباح',
    text: 'أَصْبَحْنَا وَأَصْبَحَ الْمُلْكُ لِلَّهِ',
    reference: 'صحيح مسلم (2723b) — مقتطف من ذكر الصباح', url: 'https://sunnah.com/muslim:2723b',
  },
  SAYYID_AL_ISTIGHFAR, TASBIH,
];
export const EVENING_ADHKAR = [
  {
    id: 'muslim-2723a-evening', title: 'من ذكر المساء',
    text: 'أَمْسَيْنَا وَأَمْسَى الْمُلْكُ لِلَّهِ وَالْحَمْدُ لِلَّهِ، لَا إِلَهَ إِلَّا اللَّهُ وَحْدَهُ لَا شَرِيكَ لَهُ، ' +
      'لَهُ الْمُلْكُ وَلَهُ الْحَمْدُ وَهُوَ عَلَى كُلِّ شَيْءٍ قَدِيرٌ، اللَّهُمَّ أَسْأَلُكَ خَيْرَ هَذِهِ اللَّيْلَةِ ' +
      'وَأَعُوذُ بِكَ مِنْ شَرِّ هَذِهِ اللَّيْلَةِ وَشَرِّ مَا بَعْدَهَا، اللَّهُمَّ إِنِّي أَعُوذُ بِكَ مِنَ الْكَسَلِ وَسُوءِ الْكِبَرِ، ' +
      'اللَّهُمَّ إِنِّي أَعُوذُ بِكَ مِنْ عَذَابٍ فِي النَّارِ وَعَذَابٍ فِي الْقَبْرِ',
    reference: 'صحيح مسلم (2723a)', url: 'https://sunnah.com/muslim:2723a',
  },
  SAYYID_AL_ISTIGHFAR, TASBIH,
];

export const BEDTIME_ADHKAR = [
  {
    id: 'bukhari-6324', title: 'الدعاء عند النوم', text: 'بِاسْمِكَ اللَّهُمَّ أَمُوتُ وَأَحْيَا',
    reference: 'صحيح البخاري (6324)', url: 'https://sunnah.com/bukhari:6324',
  },
  {
    id: 'muslim-2727a', title: 'التسبيح والتحميد والتكبير عند النوم',
    text: 'سُبْحَانَ اللَّهِ — 33 مرة\nالْحَمْدُ لِلَّهِ — 33 مرة\nاللَّهُ أَكْبَرُ — 34 مرة',
    reference: 'صحيح مسلم (2727a)', url: 'https://sunnah.com/muslim:2727a',
  },
];

export const FRIDAY_SOURCE = {
  reference: 'قراءة سورة الكهف يوم الجمعة — صحيح الجامع (6470)، صححه الألباني',
  url: 'https://dorar.net/h/xEr7mhnH?osoul=1',
};

export function reminderForPeriod(period) {
  if (!PERIODS.includes(period)) throw new Error('Choose morning, evening, bedtime or friday.');
  if (period === 'friday') return [
    '📖 *تذكير الجمعة — سورة الكهف*', '',
    'تذكير بقراءة سورة الكهف اليوم.', 'رابط القراءة: https://quran.com/18', '',
    `المصدر: ${FRIDAY_SOURCE.reference}`, FRIDAY_SOURCE.url,
  ].join('\n');
  const entries = { morning: MORNING_ADHKAR, evening: EVENING_ADHKAR, bedtime: BEDTIME_ADHKAR }[period];
  const title = { morning: '🌅 *أذكار الصباح*', evening: '🌙 *أذكار المساء*', bedtime: '🛏️ *أذكار النوم*' }[period];
  return [title, '',
    ...entries.flatMap((entry) => [
      `*${entry.title}*`, entry.text,
      ...(entry.count ? [`التكرار: ${entry.count} مرة ${period === 'morning' ? 'في الصباح' : 'في المساء'}.`] : []),
      `المصدر: ${entry.reference}`, entry.url, '',
    ]),
  ].join('\n').trim();
}

export function sourceList() {
  const unique = [...new Map([...MORNING_ADHKAR, ...EVENING_ADHKAR, ...BEDTIME_ADHKAR, FRIDAY_SOURCE].map((entry) => [entry.url, entry])).values()];
  return ['Morning/evening/bedtime adhkar use Sahih Muslim and Sahih al-Bukhari. The Friday reading reminder cites the grading by al-Albani.',
    ...unique.map((entry) => `${entry.reference}\n${entry.url}`),
  ].join('\n\n');
}
