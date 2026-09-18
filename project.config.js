module.exports = {
  port: 3912,
  title: '钟乳石洞穴微环境巡测',
  lede: '围绕洞穴样点登记巡测读数，自动对照样点基准判定；超阈即进入复查闭环，三项全部回到范围内才关闭。调整基准会使未关闭异常的旧判定失效并按新基准重核。',
  thresholds: {
    temp: 1.5,
    humidity: 6,
    co2: 150
  },
  tones: {
    '常规观察': 'ok',
    '正常': 'ok',
    '已关闭': 'ok',
    '重点保护': 'warn',
    '异常待复查': 'bad',
    '暂停开放': 'bad'
  },
  collections: {
    sites: { label: '样点档案' },
    surveys: { label: '巡测记录' },
    reviews: { label: '复查记录' }
  },
  stats: [
    { label: '样点', collection: 'sites' },
    { label: '重点保护', collection: 'sites', filter: { field: 'protectedStatus', value: '重点保护' } },
    { label: '巡测记录', collection: 'surveys' },
    { label: '待复查', collection: 'surveys', filter: { field: 'status', value: '异常待复查' } }
  ],
  views: [
    {
      id: 'dashboard',
      label: '复查看板',
      type: 'dashboard',
      focusTitle: '待复查异常',
      focus: { collection: 'surveys', field: 'status', values: ['异常待复查'], limit: 10 }
    },
    {
      id: 'sites',
      label: '样点档案',
      collection: 'sites',
      formTitle: '新增样点',
      listTitle: '样点列表',
      submitLabel: '保存样点',
      searchPlaceholder: '搜索洞穴、分区、样点、路线',
      searchFields: ['cave', 'zone', 'pointCode', 'route', 'note'],
      statusField: 'protectedStatus',
      statusOptions: ['常规观察', '重点保护', '暂停开放'],
      titleFields: ['pointCode', 'zone'],
      fields: [
        { label: '洞穴', name: 'cave', required: true },
        { label: '分区', name: 'zone', required: true },
        { label: '样点编号', name: 'pointCode', required: true },
        { label: '巡测路线', name: 'route', required: true },
        { label: '敏感等级', name: 'sensitivity', type: 'select', options: ['低', '中', '高'] },
        { label: '保护状态', name: 'protectedStatus', type: 'select', options: ['常规观察', '重点保护', '暂停开放'] },
        { label: '基准温度(℃)', name: 'baselineTemp', type: 'number', required: true, step: 0.1 },
        { label: '基准湿度(%)', name: 'baselineHumidity', type: 'number', required: true, step: 1 },
        { label: '基准CO2(ppm)', name: 'baselineCo2', type: 'number', required: true, step: 1 },
        { label: '备注', name: 'note', type: 'textarea', wide: true }
      ]
    },
    {
      id: 'surveys',
      label: '巡测登记',
      collection: 'surveys',
      formTitle: '登记巡测',
      listTitle: '巡测历史',
      submitLabel: '保存巡测',
      searchPlaceholder: '搜索人员、日期、干扰痕迹、样点',
      searchFields: ['surveyor', 'date', 'disturbance'],
      statusField: 'status',
      statusOptions: ['正常', '异常待复查', '已关闭'],
      titleFields: ['surveyor', 'date'],
      fields: [
        { label: '样点', name: 'siteId', type: 'relation', collection: 'sites', labelFields: ['cave', 'zone', 'pointCode'], required: true, wide: true },
        { label: '巡测人员', name: 'surveyor', required: true },
        { label: '日期', name: 'date', type: 'date', required: true },
        { label: '温度(℃)', name: 'temperature', type: 'number', step: 0.1, required: true },
        { label: '湿度(%)', name: 'humidity', type: 'number', step: 1, required: true },
        { label: 'CO2(ppm)', name: 'co2', type: 'number', step: 1, required: true },
        { label: '滴水频率(次/分)', name: 'dripRate', type: 'number', step: 1, required: true },
        { label: '照片链接', name: 'photoUrl' },
        { label: '游客干扰痕迹', name: 'disturbance', type: 'textarea', wide: true }
      ]
    },
    {
      id: 'reviews',
      label: '异常与复查',
      collection: 'surveys',
      listTitle: '异常历史',
      searchPlaceholder: '搜索样点、人员、日期、结论',
      statusField: 'status',
      statusOptions: ['异常待复查', '已关闭', '正常']
    }
  ]
};
