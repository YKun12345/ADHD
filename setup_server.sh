#!/bin/bash
# ADHD Web 应用 - 阿里云服务器环境准备脚本
# 使用方法: 在服务器上执行 bash setup_server.sh

set -e

echo "========================================="
echo "  ADHD Web 应用 - 服务器环境准备"
echo "========================================="

# 检查是否为root用户
if [ "$EUID" -ne 0 ]; then 
    echo "错误: 请使用root用户执行此脚本"
    exit 1
fi

# 1. 更新系统
echo ""
echo "[1/6] 更新系统..."
yum update -y

# 2. 安装基础依赖
echo ""
echo "[2/6] 安装基础依赖..."
yum install -y git wget curl vim

# 3. 安装Python 3.11
echo ""
echo "[3/6] 安装Python 3.11..."
if ! command -v python3.11 &> /dev/null; then
    yum install -y python311 python311-pip python311-devel
    echo "Python 3.11 安装完成"
else
    echo "Python 3.11 已安装"
fi

python3.11 --version

# 4. 安装MySQL
echo ""
echo "[4/6] 安装MySQL..."
if ! command -v mysql &> /dev/null; then
    yum install -y mysql mysql-server mysql-devel
    echo "MySQL 安装完成"
else
    echo "MySQL 已安装"
fi

# 启动MySQL
systemctl start mysqld
systemctl enable mysqld

# 获取临时密码
echo ""
echo "MySQL 临时密码:"
grep 'temporary password' /var/log/mysqld.log || echo "未找到临时密码，可能已设置过"

# 5. 安装Nginx
echo ""
echo "[5/6] 安装Nginx..."
if ! command -v nginx &> /dev/null; then
    yum install -y nginx
    echo "Nginx 安装完成"
else
    echo "Nginx 已安装"
fi

systemctl start nginx
systemctl enable nginx

# 6. 安装编译工具
echo ""
echo "[6/6] 安装编译工具..."
yum install -y gcc gcc-c++ make

echo ""
echo "========================================="
echo "  环境准备完成！"
echo "========================================="
echo ""
echo "下一步操作:"
echo "1. 设置MySQL root密码: mysql_secure_installation"
echo "2. 创建数据库: mysql -u root -p"
echo "3. 上传项目代码到 /opt/ADHD_Web"
echo "4. 创建Python虚拟环境并安装依赖"
echo "5. 配置并启动应用"
