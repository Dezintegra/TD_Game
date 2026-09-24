export const mutations = [
  {
    id: 'fragile-base-under-fire',
    tuning: { baseHealth: 0.000001 },
    description: 'База не переживает первый выстрел.',
  },
  {
    id: 'fragile-building-progress',
    tuning: { towerHealth: 0.001 },
    description: 'Единица здоровья стирает различимость стадий постройки.',
  },
  {
    id: 'income-overwhelms-payment',
    tuning: { income: 100000 },
    description: 'Доход тика перекрывает платёж за стену.',
  },
];

export const pairs = [
  {
    mutationId: 'fragile-base-under-fire',
    testFile: 'packages/sim/src/step.test.ts',
    fullName: [
      'огонь по базе с подхода',
      'останавливается в четырёх клетках от края основания и бьёт по базе',
    ],
    rationale: 'Проверка требует живую базу после остановки и обстрела.',
    probe: 'baseHealth',
  },
  {
    mutationId: 'fragile-building-progress',
    testFile: 'packages/sim/src/step.test.ts',
    fullName: ['строительство', 'снайперская башня на середине возведения заметно слабее готовой'],
    rationale: 'Промежуточное здоровье должно находиться между 0.3 и 0.7 максимума.',
    probe: 'towerHealth',
  },
  {
    mutationId: 'income-overwhelms-payment',
    testFile: 'packages/sim/src/step.test.ts',
    fullName: ['строительство', 'ставит стену рядом с генералом и списывает энергию'],
    rationale: 'Запас энергии после платежа должен уменьшиться.',
    probe: 'income',
  },
];
