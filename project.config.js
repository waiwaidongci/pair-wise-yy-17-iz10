module.exports = {
  port: 3912,
  title: '钟乳石洞穴微环境巡测',
  lede: '巡测读数与样点基准实时比对：温差超1.5℃、湿度差超6个百分点或CO2增量超150ppm即列入待复查，不能手标正常；复查登记新读数与结论，三项回范围内才闭环，否则累计次数继续待查。调整基准会使未关闭异常的旧判定失效并按新基准重核。',
  thresholds: {
    temp: 1.5,
    humidity: 6,
    co2: 150
  },
  tones: {
    '常规观察': 'ok',
    '正常': 'ok',
    '已复查': 'ok',
    '已恢复': 'ok',
    '已关闭': 'ok',
    '重点保护': 'warn',
    '异常待复查': 'bad',
    '仍异常': 'bad',
    '暂停开放': 'bad'
  },
  collections: {
    sites: { label: '样点档案' },
    surveys: { label: '巡测记录' }
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
      label: '闭环看板',
      type: 'dashboard',
      focusTitle: '异常待复查（复查闭环）',
      focus: { collection: 'surveys', field: 'status', values: ['异常待复查'], limit: 50 }
    },
    {
      id: 'sites',
      label: '样点档案',
      collection: 'sites',
      formTitle: '新增样点',
      listTitle: '样点列表',
      submitLabel: '保存样点',
      searchPlaceholder: '搜索洞穴、分区、样点、路线',
      searchFields: ['cave', 'zone', 'pointCode', 'route'],
      statusField: 'protectedStatus',
      statusOptions: ['常规观察', '重点保护', '暂停开放'],
      titleFields: ['pointCode', 'zone'],
      summaryFields: ['note'],
      detailFields: [
        { label: '洞穴', name: 'cave' },
        { label: '巡测路线', name: 'route' },
        { label: '敏感等级', name: 'sensitivity' }
      ],
      fields: [
        { label: '洞穴', name: 'cave', required: true },
        { label: '分区', name: 'zone', required: true },
        { label: '样点编号', name: 'pointCode', required: true },
        { label: '巡测路线', name: 'route', required: true },
        { label: '敏感等级', name: 'sensitivity', type: 'select', options: ['低', '中', '高'] },
        { label: '保护状态', name: 'protectedStatus', type: 'select', options: ['常规观察', '重点保护', '暂停开放'] },
        { label: '基准温度(℃)', name: 'baselineTemp', type: 'number', required: true },
        { label: '基准湿度(%)', name: 'baselineHumidity', type: 'number', required: true },
        { label: '基准CO2(ppm)', name: 'baselineCo2', type: 'number', required: true },
        { label: '备注', name: 'note', type: 'textarea', wide: true }
      ]
    },
    {
      id: 'surveys',
      label: '巡测记录',
      collection: 'surveys',
      formTitle: '登记巡测（按基准自动判定）',
      listTitle: '巡测与异常历史',
      submitLabel: '保存巡测',
      searchPlaceholder: '搜索人员、干扰痕迹、照片、复查结论',
      searchFields: ['surveyor', 'disturbance', 'photoUrl'],
      statusField: 'status',
      statusOptions: ['正常', '异常待复查', '已关闭'],
      titleFields: ['surveyor', 'date'],
      relation: { collection: 'sites', localKey: 'siteId', labelFields: ['cave', 'zone', 'pointCode'] },
      summaryFields: ['disturbance'],
      detailFields: [
        { label: '温度', name: 'temperature' },
        { label: '湿度', name: 'humidity' },
        { label: 'CO2', name: 'co2' }
      ],
      fields: [
        { label: '样点', name: 'siteId', type: 'relation', collection: 'sites', labelFields: ['cave', 'zone', 'pointCode'], required: true, wide: true },
        { label: '巡测人员', name: 'surveyor', required: true },
        { label: '日期', name: 'date', type: 'date', required: true },
        { label: '温度(℃)', name: 'temperature', type: 'number', required: true },
        { label: '湿度(%)', name: 'humidity', type: 'number', required: true },
        { label: 'CO2(ppm)', name: 'co2', type: 'number', required: true },
        { label: '滴水频率', name: 'dripRate', type: 'number', required: true },
        { label: '照片链接', name: 'photoUrl' },
        { label: '游客干扰痕迹', name: 'disturbance', type: 'textarea', wide: true }
      ]
    }
  ],
  actions: [
    { id: 'site-normal', label: '常规观察', collection: 'sites', patches: [{ field: 'protectedStatus', value: '常规观察' }] },
    { id: 'site-focus', label: '重点保护', collection: 'sites', patches: [{ field: 'protectedStatus', value: '重点保护' }] },
    { id: 'site-close', label: '暂停开放', collection: 'sites', danger: true, patches: [{ field: 'protectedStatus', value: '暂停开放' }] }
  ]
};
