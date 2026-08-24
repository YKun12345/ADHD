const { registerPatientPage } = require('../../utils/patient-page')
const {
  summarizePatientData,
  clearPatientData,
  endPatientSession,
  hasValidPatientSession,
  capturePatientSessionLease,
  isPatientSessionLeaseCurrent
} = require('../../utils/session-privacy')

registerPatientPage({
  data: {
    patientName: '患者',
    draftCount: 0,
    resultCount: 0,
    trackingDayCount: 0,
    pendingCount: 0,
    totalLocalItems: 0,
    acting: false
  },

  onLoad() {
    this.refreshSummary()
  },

  refreshSummary() {
    const currentUser = wx.getStorageSync('current_user')
    const fullName = currentUser && typeof currentUser.full_name === 'string'
      ? currentUser.full_name.trim()
      : ''

    this.setData({
      patientName: fullName || '患者',
      ...summarizePatientData()
    })
  },

  _confirm(options) {
    const lease = capturePatientSessionLease()
    return new Promise((resolve) => {
      let settled = false

      const settle = (value) => {
        if (settled) return
        settled = true
        resolve(value)
      }

      try {
        wx.showModal({
          ...options,
          success(result) {
            settle(
              isPatientSessionLeaseCurrent(lease) &&
              Boolean(result && result.confirm === true)
            )
          },
          cancel() {
            settle(false)
          },
          fail() {
            settle(false)
          }
        })
      } catch (error) {
        settle(false)
      }
    })
  },

  async clearLocalData() {
    if (this.data.acting) return false

    this.setData({ acting: true })

    try {
      const confirmed = await this._confirm({
        title: '确认清除本地数据',
        content: '只清除本机草稿、结果、追踪和待同步记录，不删除服务器已保存数据',
        confirmText: '确认清除'
      })

      if (!confirmed) return false

      const clearResult = clearPatientData()
      this.refreshSummary()
      if (!clearResult.ok) {
        wx.showToast({
          title: '本地数据清理失败，请重试',
          icon: 'none'
        })
        return false
      }

      wx.showToast({
        title: '本地数据已清除',
        icon: 'none'
      })
      return true
    } finally {
      this.setData({ acting: false })
    }
  },

  async logout() {
    if (this.data.acting) return false

    this.setData({ acting: true })
    let keepActing = false

    try {
      const confirmed = await this._confirm({
        title: '确认退出账号',
        content: '退出账号将清除本机患者数据，未同步数据将无法恢复',
        confirmText: '退出账号'
      })

      if (!confirmed) return false

      const endResult = endPatientSession()
      if (!endResult.ok) {
        wx.showToast({
          title: '账号退出清理失败，请重试',
          icon: 'none'
        })
      }

      if (hasValidPatientSession()) {
        return false
      }

      const reLaunchSucceeded = await new Promise((resolve) => {
        let settled = false
        const settle = (value) => {
          if (settled) return
          settled = true
          resolve(value)
        }

        try {
          wx.reLaunch({
            url: '/pages/login/index',
            success() {
              settle(true)
            },
            fail() {
              settle(false)
            }
          })
        } catch (error) {
          settle(false)
        }
      })

      if (!reLaunchSucceeded) {
        wx.showToast({
          title: '返回登录页失败，请重试',
          icon: 'none'
        })
        return false
      }

      keepActing = true
      return endResult.ok
    } finally {
      if (!keepActing) {
        this.setData({ acting: false })
      }
    }
  },

  onPatientSessionEnded() {
    this.setData({ acting: true })
  },

  goBack() {
    wx.navigateBack({ delta: 1 })
  }
})
