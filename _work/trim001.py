# -*- coding: utf-8 -*-
import re, io, os

f = r'D:\桌面\战前下议院人物档案_20261020\01_人物档案\001_莱斯利·霍尔-贝利沙_Leslie_Hore-Belisha.md'
t = open(f, encoding='utf-8').read()

newmap = {
 'E-001':'E-001','E-002':'E-002','E-003':'E-003',
 'E-005':'E-004','E-006':'E-005','E-007':'E-006','E-008':'E-007','E-009':'E-008',
 'E-011':'E-009','E-012':'E-010','E-013':'E-011','E-014':'E-012','E-015':'E-013','E-016':'E-014',
 'E-018':'E-015','E-019':'E-016','E-021':'E-017','E-022':'E-018','E-023':'E-019','E-025':'E-020',
 'E-026':'E-021','E-027':'E-022','E-028':'E-023','E-029':'E-024','E-030':'E-025',
}
deleted = {'E-004':'E-009','E-010':'E-008','E-017':'E-014','E-020':'E-017','E-024':'E-020'}

# split into blocks at E entry headers
parts = re.split(r'(?m)(?=^- \*\*\[E-0\d+\]\*\*)', t)
head = parts[0]
blocks = parts[1:]

kept = []
merge_src = {}
for b in blocks:
    m = re.match(r'^- \*\*\[(E-0\d+)\]\*\*', b)
    n = m.group(1)
    if n in deleted:
        src = [l for l in b.split('\n') if l.strip().startswith('- 出处')]
        merge_src.setdefault(deleted[n], []).extend(src)
    else:
        kept.append((n, b))

# rebuild blocks with renumbered ids and merged sources
out_blocks = []
for n, b in kept:
    nn = newmap[n]
    b = b.replace('[%s]' % n, '[%s]' % nn, 1)
    if nn in merge_src:
        lines = b.rstrip('\n').split('\n')
        for s in merge_src[nn]:
            lines.append('  - 出处（合并入本条）：' + s.strip()[4:].strip())
        b = '\n'.join(lines) + '\n'
    out_blocks.append(b)

t2 = head + ''.join(out_blocks)

# fix frontmatter count
t2 = t2.replace('外部条目数: 25\n', '外部条目数: 25\n')  # no-op placeholder
t2 = re.sub(r'外部条目数: \d+', '外部条目数: 25', t2)

# fix section 9 reference list and statistics line
t2 = t2.replace('E-011/E-013/E-019/E-021（单一日志/镜像来源，标 [B-单一维基来源，待考]）',
                'E-009/E-011/E-016/E-017（单一维基/论坛/博客来源，标 [B-单一维基来源，待考]）')
t2 = t2.replace('**统计**：B 层 26 条（B-001…B-026）、E 层 30 条（E-001…E-030）、V 层 17 条（V-001…V-017）。',
                '**统计**：B 层 26 条（B-001…B-026）、E 层 25 条（E-001…E-025）、V 层 17 条（V-001…V-017）。')

# fix index table E rows: renumber remaining rows and drop deleted ones
def fix_row(m):
    num = m.group(1)
    if num in deleted: return ''
    return m.group(0).replace(num, newmap[num], 1)
t2 = re.sub(r'(?m)^\| (E-0\d+) \|(.*)$', fix_row, t2)

open(f, 'w', encoding='utf-8', newline='\n').write(t2)
print('E entries now:', len(re.findall(r'(?m)^- \*\*\[E-0\d+\]\*\*', t2)))
print('deleted left:', [d for d in deleted if ('[%s]'%d) in t2])
print('bytes', len(t2.encode('utf-8')))
