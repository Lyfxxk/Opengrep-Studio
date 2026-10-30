import io

NL = chr(10)
Q = chr(39)

def entry(key, value):
    return "    " + key + ": " + Q + value + Q + "," + NL

jobs = {
    'code/src/i18n/zh.ts': [
        entry('subtitle', '创建并管理代码审查项目，上传源码 ZIP 后发起 opengrep 扫描'),
        entry('updateSuccess', '项目已更新'),
        entry('createSuccess', '项目创建成功'),
        entry('deleteSuccess', '项目已删除'),
        entry('batchDeleted_one', '已删除 {{count}} 个项目'),
        entry('batchDeleted_other', '已删除 {{count}} 个项目'),
        entry('listTitle', '项目列表'),
    ],
    'code/src/i18n/en.ts': [
        entry('subtitle', 'Create and manage code review projects, upload a source ZIP, then run an opengrep scan'),
        entry('updateSuccess', 'Project updated'),
        entry('createSuccess', 'Project created'),
        entry('deleteSuccess', 'Project deleted'),
        entry('batchDeleted_one', '{{count}} project deleted'),
        entry('batchDeleted_other', '{{count}} projects deleted'),
        entry('listTitle', 'Project List'),
    ],
    'code/src/i18n/zh-Hant.ts': [
        entry('subtitle', '建立並管理程式碼審查專案，上傳原始碼 ZIP 後發起 opengrep 掃描'),
        entry('updateSuccess', '專案已更新'),
        entry('createSuccess', '專案建立成功'),
        entry('deleteSuccess', '專案已刪除'),
        entry('batchDeleted_one', '已刪除 {{count}} 個專案'),
        entry('batchDeleted_other', '已刪除 {{count}} 個專案'),
        entry('listTitle', '專案列表'),
    ],
}

for path, keys in jobs.items():
    s = io.open(path, encoding='utf-8').read()
    for k in keys:
        if k not in s:
            raise SystemExit(path + ' missing ' + repr(k))
        while k in s:
            s = s.replace(k, '', 1)
    io.open(path, 'w', encoding='utf-8', newline='').write(s)
print('ok')
