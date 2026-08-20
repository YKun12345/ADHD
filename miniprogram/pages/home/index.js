// pages/home/index.js
Page({
  data: {
    userName: '患者',
    currentDay: 1,
    totalDays: 14,
    completedDays: 0,
    progressPercent: 0,

    tasks: [
      {
        id: 'scale',
        icon: '量',
        title: '行为量表',
        description: '完成今日注意力行为评估'
      },
      {
        id: 'cognitive',
        icon: '测',
        title: '认知测试',
        description: '完成反应力与注意力测试'
      },
      {
        id: 'tracking',
        icon: '记',
        title: '每日追踪',
        description: '记录睡眠、情绪和用药情况'
      }
    ],

    quickEntries: [
      {
        id: 'scale',
        icon: '量',
        title: '行为量表'
      },
      {
        id: 'cognitive',
        icon: '测',
        title: '认知测试'
      },
      {
        id: 'tracking',
        icon: '踪',
        title: '14天追踪'
      },
      {
        id: 'report',
        icon: '报',
        title: '综合报告'
      }
    ]
  },

  onLoad() {
    const user = wx.getStorageSync('current_user')

    if (user && user.full_name) {
      this.setData({
        userName: user.full_name
      })
    }
  },

  handleTaskTap(event) {
    const title = event.currentTarget.dataset.title

    wx.showToast({
      title: `${title}功能开发中`,
      icon: 'none'
    })
  },

  handleEntryTap(event) {
    const title = event.currentTarget.dataset.title

    wx.showToast({
      title: `${title}功能开发中`,
      icon: 'none'
    })
  }
})