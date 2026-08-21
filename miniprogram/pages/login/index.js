const { request } = require('../../utils/request')

Page({
  data: {
    identifier: '',
    password: '',
    submitting: false
  },

  onShow() {
    const token = wx.getStorageSync('access_token')
    const user = wx.getStorageSync('current_user')

    if (token && user) {
      wx.reLaunch({
        url: '/pages/home/index'
      })
    }
  },

  onIdentifierInput(event) {
    this.setData({
      identifier: event.detail.value
    })
  },

  onPasswordInput(event) {
    this.setData({
      password: event.detail.value
    })
  },

  goToRegister() {
    wx.navigateTo({
      url: '/pages/register/index'
    })
  },

  async handleLogin() {
    const identifier = this.data.identifier.trim()
    const password = this.data.password

    if (!identifier) {
      wx.showToast({
        title: '请输入账号',
        icon: 'none'
      })
      return
    }

    if (identifier.length < 3) {
      wx.showToast({
        title: '账号至少需要3个字符',
        icon: 'none'
      })
      return
    }

    if (!password) {
      wx.showToast({
        title: '请输入密码',
        icon: 'none'
      })
      return
    }

    if (password.length < 6) {
      wx.showToast({
        title: '密码至少需要6个字符',
        icon: 'none'
      })
      return
    }

    this.setData({
      submitting: true
    })

    try {
      const result = await request({
        url: '/auth/login',
        method: 'POST',
        data: {
          identifier,
          password,
          role: 'patient'
        }
      })

      if (!result.access_token) {
        throw new Error('服务器未返回登录凭证')
      }

      wx.setStorageSync('access_token', result.access_token)
      wx.setStorageSync('current_user', result.user)

      wx.showToast({
        title: '登录成功',
        icon: 'success'
      })

      setTimeout(() => {
        wx.reLaunch({
          url: '/pages/home/index'
        })
      }, 600)
    } catch (error) {
      wx.showToast({
        title: error.message || '登录失败',
        icon: 'none',
        duration: 2500
      })
    } finally {
      this.setData({
        submitting: false
      })
    }
  }
})
