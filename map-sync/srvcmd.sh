#!/bin/sh
# 往 srcds 的控制台注入一行命令。
#
# 为什么不用 echo > /dev/pts/N：
#   写 /dev/pts/N 是往那个终端"输出"字符 —— 会被显示、被 script(1) 记进日志，
#   但不会进入 srcds 的 stdin，所以命令有回显却不执行。看上去像成功了，其实没有。
#   真正注入输入必须用 TIOCSTI ioctl（需要 CAP_SYS_ADMIN，故整个脚本用 sudo 跑）。
#
# 用法: sudo ./srvcmd.sh "changelevel de_inferno"

PTS=$(ps -o tty= -p "$(pgrep -f srcds_linux | head -1)" | tr -d ' ')
if [ -z "$PTS" ]; then
    echo "srcds_linux 未运行"
    exit 1
fi

python3 -c "
import os, fcntl, sys
tty = '/dev/$PTS'
fd = os.open(tty, os.O_RDWR)
for ch in (sys.argv[1] + '\n').encode():
    fcntl.ioctl(fd, 0x5412, bytes([ch]))   # TIOCSTI
print('已注入 ' + tty + ': ' + sys.argv[1])
" "$1"
