"""Verified mini-program entries, separated by the authenticated workspace role."""

COMMON = {
    'notification_help': '对话中的文字是星仔对本次问题的回答；下方“业务提醒”根据当前已保存的业务记录生成。业务提醒不等同于医生刚发来的消息。要看医生或用户实际发送的内容，请打开底部“沟通”里的“共享消息”，选择对应档案和共享关系。这里与星仔的聊天不会自动发送给对方。',
    'account_help': '账号和授权入口在底部“我的”→“账号与隐私”。登录问题先检查当前账号；提示未获授权时，核对本人、监护或医患共享关系及具体共享范围。不要把密码或验证码发给星仔。',
}
HELP = {
    'researcher': {
        'imaging_help': '在医生端，点底部“用户”→选择对应用户→“已生成影像报告与实际审核版本”，就能看这位用户的已有影像报告、来源、局限及审核版本。它与评估中的“医生意见”是不同入口。原始影像的上传、查看和分析在电脑医生端完成。若列表为空，请核对报告是否已生成，以及共享范围是否包含影像；我目前没有读取影像报告列表，不能判断这位用户有没有报告。',
        'report_help': '在医生端，点底部“用户”→选择对应用户。量表与认知等既有数据在用户详情页查看；本轮发布的医生意见在“发起评估或查看已有轮次”→选择对应轮次→“查看本轮报告与已发布意见”。影像报告请点详情页的“已生成影像报告与实际审核版本”。',
        'identity_help': '当前我是你的医生助手，帮助你处理获准用户的材料、报告、补问与计划。我会按医生端的入口回答；不会把你当作接受评估的用户。你和星仔的聊天不会自动发送给用户，消息、专业意见和计划仍需你在对应页面确认后发送或发布。',
    },
    'patient': {
        'imaging_help': '在用户端，点底部“评估”→“我的数据与报告”→“已生成影像报告与实际审核版本”，查看当前档案已有的影像报告。它与本轮评估的“医生意见”是不同内容。原始影像由医生在电脑端处理，小程序用于查看已有报告。若列表为空，请向医生确认是否已生成并发布；我目前没有读取影像报告列表，不能判断你有没有报告。',
        'report_help': '点底部“评估”→“本轮评估与历史轮次”→选择对应轮次→“查看本轮报告与已发布意见”，阅读医生意见和局限。量表、认知等既有数据在“评估”→“我的数据与报告”；影像报告从该页的“已生成影像报告与实际审核版本”进入。没有医生意见时，可以通过“沟通”→“共享消息”向医生确认。',
        'identity_help': '当前我是你的用户助手，帮助你使用小程序、完成评估、查看报告和与医生沟通。下方业务提醒来自已保存的安排；它不会代替我回答你刚才的问题。你和星仔的聊天不会自动发送给医生，向医生反馈时需要在共享消息等实际页面确认发送。',
    },
}


def product_help_topic(message):
    text = message.lower()
    if any(word in text for word in ('推送', '提醒', '通知', '医生发来的', '医生发的')):
        return 'notification_help'
    if any(word in text for word in ('服务用户', '服务医生', '服务谁', '用户还是医生', '医生还是用户', '我的身份', '什么身份')):
        return 'identity_help'
    if any(word in text for word in ('影像', '脑图', 'mri', '核磁')):
        return 'imaging_help'
    if any(word in text for word in ('报告', '医生意见', '审核意见')):
        return 'report_help'
    if any(word in text for word in ('登录', '注册', '账号', '账户', '密码', '验证码', '授权', '隐私', '权限')):
        return 'account_help'
    return None


def product_help_answer(role, topic):
    return {**COMMON, **HELP[role]}.get(topic)


def product_help_context(role):
    # Static product instructions only: never append patient data or business state.
    label = '医生助手' if role == 'researcher' else '用户助手'
    return f'当前使用的是{label}，按这个实际角色回答，不根据问题里的称呼猜测身份。已核对的小程序入口：\n' + '\n'.join(
        product_help_answer(role, topic) for topic in ('imaging_help', 'report_help', 'identity_help', 'notification_help', 'account_help'))
