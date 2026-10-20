"""Local interpretation keeps free text private; suggestions use current business facts."""
import re

REMOTE_TOPICS = frozenset({'next_step', 'progress', 'assessment_help', 'plan_help', 'record_help', 'communication_help', 'difficulty'})
ATTENTION_TERMS = ('注意力', '专注', '分心', '走神', '拖延', '冲动', '多动', 'adhd', '集中精神',
    '学习效率', '作业', '执行力', '时间管理', '遗忘', '记不住', '任务拆解', '学习困难')


def is_product_question(message, conversation_preview=None):
    """Product workflow and related attention difficulties; not a general life AI."""
    text = message.lower()
    product = any(word in text for word in (
        '小程序', '页面', '按钮', '点击', '登录', '注册', '账号', '账户', '密码', '验证码',
        '权限', '授权', '隐私', '撤回', '报错', '打不开', '未完成', '没反应', '返回',
        '报告', '审核', '影像', '用户端', '医生端', '工作台', '监护人', '儿童', '看不到'))
    attention = any(word in text for word in ATTENTION_TERMS)
    if not product and not attention and any(word in text for word in ('旅游', '食谱', '菜谱', '美食', '股票', '投资', '天气预报', '讲笑话')):
        return False
    if product or attention or question_topic(message) != 'open_question':
        return True
    # A selected earlier attention question cannot turn any new topic into a
    # general chat. Only an explicit reference may inherit its product scope.
    referring = any(word in text for word in ('刚才', '这个', '那个', '继续', '接着', '上一个', '上一条'))
    return bool(referring and conversation_preview and any(
        is_product_question(turn['user_message']) for turn in conversation_preview.get('turns', [])))


def conversation_safety_boundary(message, conversation_preview=None):
    from backend.app.services.ai_service import _is_high_risk_message
    texts = [message] + [turn[field] for turn in (conversation_preview or {}).get('turns', [])
        for field in ('user_message', 'assistant_message')]
    if any(_is_high_risk_message(text) or re.search(
            r'\b(?:suicide|suicidal|self[- ]?harm|kill myself|hurt myself|end my life)\b', text, re.I) for text in texts):
        return 'high_risk'
    if any(question_topic(text) == 'clinical' for text in texts):
        return 'clinical'
    return None


def question_topic(message):
    text = re.sub(r'[\s，。！？!?、,.~～]+', '', message).lower()
    if text in {'你好', '您好', '嗨', 'hi', 'hello', '哈喽', '在吗', '星仔', '你好星仔', '星仔你好', '你是谁'}:
        return 'greeting'
    if any(word in text for word in ('诊断', '确诊', '药量', '加药', '减药', '停药', '换药', '用药', '服药', '吃药',
            '药物剂量', '治疗方案', '治疗效果', '是不是adhd', 'diagnos', 'dosage', 'medication')):
        return 'clinical'
    if any(word in text for word in ('同步', '提交', '保存', '发不出去')):
        return 'delivery'
    if any(word in text for word in ('跳过', '背景', '不知道')):
        return 'optional_background'
    if any(word in text for word in ('太难', '困难', '跟不上', '紧张', '做不完', '不想做', '累了', '不会做')):
        return 'difficulty'
    if any(word in text for word in ('下一步', '先做', '先处理', '该做什么', '应该做什么', '现在做什么', '接下来', '陪我')):
        return 'next_step'
    if any(word in text for word in ('齐全', '进展', '做完', '完成了', '还差', '还缺', '材料')):
        return 'progress'
    from backend.app.services.agent.product_help import product_help_topic
    help_topic = product_help_topic(message)
    if help_topic:
        return help_topic
    if any(word in text for word in ('消息', '回复', '补问', '联系医生', '反馈')):
        return 'communication_help'
    if any(word in text for word in ('计划', '安排', '周期结束')):
        return 'plan_help'
    if any(word in text for word in ('记录', '随访', '留空', '周期')):
        return 'record_help'
    if any(word in text for word in ('评估', '测试', '量表', '怎么开始', '如何使用', '怎样使用')):
        return 'assessment_help'
    if any(word in text for word in ('能做什么', '有什么用', '能帮', '草稿')):
        return 'capabilities'
    if any(word in text for word in ATTENTION_TERMS):
        return 'attention_help'
    return 'open_question'


def answer_question(frame, request, summary):
    boundary = conversation_safety_boundary(request['message'], request.get('_conversation_preview'))
    if boundary == 'high_risk':
        from backend.app.services.ai_service import _high_risk_reply
        return 'high_risk', _high_risk_reply()
    topic = question_topic(request['message'])
    if boundary == 'clinical':
        topic = 'clinical'
    doctor = frame['role'] == 'researcher'
    if topic == 'greeting':
        return topic, ('你好呀，我是星仔。我会帮你用好医生工作台。你可以问我先审核什么、如何补问或发布计划。'
            if doctor else '你好呀，我是星仔。我会陪你用好这个小程序。你可以问我怎么做评估、查看医生意见，或下一步去哪里。')
    if topic == 'clinical':
        return topic, '这个问题需要负责医生结合实际资料判断，我不能替你确诊或调整用药。我可以陪你找到已发布的意见，或把你想问医生的事情说清楚。'
    from backend.app.services.agent.product_help import product_help_answer
    product_answer = product_help_answer(frame['role'], topic)
    if product_answer:
        return topic, product_answer
    if topic == 'delivery':
        return topic, '先不用重新做一遍。打开“待同步记录与恢复”，查询这条原记录是否已经收到；若仍未收到，再按页面提示重试。只有服务器确认收到，才算提交成功。'
    if topic == 'optional_background':
        return topic, '可以跳过，不知道也可以直接说明。我们不会把空白当成“没有这种情况”。你可以先完成当前项目，之后医生需要时再针对具体问题补充。'
    if topic == 'difficulty':
        return topic, '我们先慢一点，不用一下完成全部。是没看懂说明，还是操作时跟不上？可以先告诉我卡在哪一步。正式认知测试如果中断，要按页面提示安排新尝试；练习不会替你算成正式完成。'
    if topic == 'communication_help':
        return topic, ('打开对应用户的共享消息，先确认接收关系，再写明你需要了解的具体情况。如果问题来自本轮材料，也可以在这轮评估里发出具体补问。'
            if doctor else '如果医生已经发了补问，点对话里的“回答医生”进入对应问题；想反馈新困难，可以打开“共享消息”，选择实际医生后再发送。这里和星仔聊的内容不会自动转发给医生。')
    if topic == 'record_help':
        return topic, '打开“日期记录与独立周期”，选择正在进行的周期和真实日期，再填写实际情况。不知道的项目可以留空；需要补充时保存一份修订，之前的记录会保留。'
    if topic == 'plan_help':
        return topic, ('先打开这一轮医生已发布的意见，再进入“发布或修订医生计划”确认具体安排和日期。我可以准备文字建议，发布前仍由你核对。'
            if doctor else '先阅读医生已经发布的计划，确认收到，再按照对应日期记录。执行有困难可以发共享消息告诉医生；星仔不会自己替医生修改安排。')
    if topic == 'assessment_help':
        return topic, ('从工作台选择实际用户，进入“发起评估或查看已有轮次”。选好适用项目后保存草稿，再明确发布，用户才会收到这一轮任务。'
            if doctor else '打开“本轮评估与历史轮次”，选择医生安排或自己的这一轮。确认实际执行者，再点一个项目的“创建新尝试”，按说明、练习、正式作答的顺序来。背景资料可以跳过。')
    if topic == 'progress':
        return topic, (f'按当前这次选择的材料，已有 {summary["submitted_items"]} 项提交，还有 {summary["missing_items"]} 项未提交。'
            f'已提交材料中，质量有效 {summary["valid_submissions"]} 份、有局限 {summary["limited_submissions"]} 份。'
            '这表示实际记录情况，医生是否验收会另外标明。你想先补齐项目，还是看看有局限的那一次？')
    if topic == 'next_step':
        from backend.app.services.agent.tools import candidates
        actions = candidates(frame)
        priorities = {'answer_questions': 0, 'repeat_requested': 1, 'receive_plan': 2, 'record_today': 3, 'review_assessment': 4, 'continue_assessment': 5}
        actions.sort(key=lambda value: priorities.get(value['kind'], 10))
        if request.get('assessment_id'):
            actions = [value for value in actions if value['target']['params'].get('assessment_id') in {None, request['assessment_id']}]
        if actions:
            action = actions[0]
            return topic, f'我们先做“{action["title"]}”这一步就好。{action["reason"]} 对话下面有对应按钮，点开后我会陪你继续；暂时不想做，也可以先告诉我原因。'
        return topic, '当前没有读到需要马上处理的安排。你可以先看看已有评估或记录，也可以告诉我想完成什么，我陪你找入口。'
    if topic == 'capabilities':
        return topic, '我可以帮你找下一步、解释怎么操作、整理本轮材料，也可以陪你说说遇到的困难。普通提问直接给你回答；只有医生需要写补问、计划或回复时，才会准备可编辑的文字建议。'
    if topic == 'attention_help':
        return topic, '你可以告诉我是学习或工作时容易走神，还是很难开始任务。先把想做的事缩成一个具体小步骤；如果这种困难持续影响生活，可以在小程序按实际日期记录，再通过共享消息告诉负责医生。需要更具体地解答这次困惑，也可以选择“智能解答”。'
    return topic, '这次我还没准确识别你要办的事情。你想找的是哪个功能的入口，还是某一步操作没有成功？告诉我功能名称或当前页面，我按具体步骤帮你找；下方业务提醒另列已有安排。'
