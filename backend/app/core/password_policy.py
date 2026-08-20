COMMON_WEAK_PASSWORDS = {
    "12345678",
    "123456789",
    "1234567890",
    "00000000",
    "11111111",
    "123123123",
    "87654321",
    "password",
    "password123",
    "admin123",
    "qwerty123",
    "qwertyuiop",
    "asdfghjk",
    "abcd1234",
    "welcome123",
    "iloveyou",
    "1q2w3e4r",
    "aa123456",
}


def get_password_policy_error(password: str) -> str | None:
    if len(password) < 8:
        return "密码长度不能少于 8 位。"

    if password.isdigit():
        return "密码不能为纯数字，请组合字母、数字或符号。"

    if password.lower() in COMMON_WEAK_PASSWORDS:
        return "当前密码过于常见，存在泄露风险，请更换为更安全的密码。"

    return None
