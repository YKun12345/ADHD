const { itemsFor, sectionUrl } = require('../../utils/workspace-navigation')
const { hasValidAnySession } = require('../../utils/role-session')
const { capturePatientSessionLease, isPatientSessionLeaseCurrent } = require('../../utils/session-privacy')
Component({
  properties: { activeKey: { type:String,value:'home' } },
  data: { items: [], navigating:false },
  lifetimes: {
    attached() { const user=wx.getStorageSync('current_user')||{}; this._actor=user.id;this._role=user.role;this._lease=capturePatientSessionLease();this._active=true;this.refresh() },
    detached() { this._active=false;this.setData({items:[],navigating:false}) }
  },
  pageLifetimes: { show() { this._active=true;this.refresh() }, hide() { this._active=false;this.setData({items:[],navigating:false}) } },
  methods: {
    usable() { const user=wx.getStorageSync('current_user')||{};return this._active && hasValidAnySession() && user.id===this._actor && user.role===this._role && isPatientSessionLeaseCurrent(this._lease) },
    refresh() { this.setData({items:this.usable()?itemsFor(this._role):[],navigating:false}) },
    open(event) {
      if(!this.usable()||this.data.navigating)return false
      const key=event.currentTarget.dataset.key,url=sectionUrl(this._role,key)
      if(!url||key===this.data.activeKey)return false
      this.setData({navigating:true})
      wx.reLaunch({url,fail:()=>{if(this.usable())this.setData({navigating:false})}});return true
    }
  }
})
