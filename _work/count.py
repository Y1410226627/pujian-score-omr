# -*- coding: utf-8 -*-
import re, json, os

bg = r'D:\桌面\历史资料\历史特殊委员会 英国下议院 背景文件（注释版·电子书）.txt'
text = open(bg, encoding='utf-8', errors='replace').read()

people = [
 (1,'莱斯利·霍尔-贝利沙','Leslie Hore-Belisha',['霍尔-贝利沙','Hore-Belisha','霍尔贝利沙','贝利沙']),
 (2,'内维尔·张伯伦','Arthur Neville Chamberlain',['张伯伦','Chamberlain']),
 (3,'塞缪尔·霍尔','Samuel John Gurney Hoare',['塞缪尔·霍尔','S. Hoare','Hoare']),
 (4,'哈利法克斯勋爵','Edward Frederick Lindley Wood',['哈利法克斯','Halifax']),
 (5,'约翰·西蒙','John Allsebrook Simon',['西蒙','Simon']),
 (6,'奥利弗·斯坦利','Oliver Frederick George Stanley',['斯坦利','Stanley']),
 (7,'斯坦霍普伯爵','James Richard Stanhope',['斯坦霍普','Stanhope']),
 (8,'霍华德·金斯利·伍德','Howard Kingsley Wood',['金斯利·伍德','Kingsley Wood']),
 (9,'马尔科姆·麦克唐纳','Malcolm Macdonald',['马尔科姆·麦克唐纳','Malcolm Macdonald']),
 (10,'托马斯·英斯基普','Thomas Walker Hobart Inskip',['英斯基普','Inskip']),
 (11,'沃尔特·艾略特','Walter Elliot',['沃尔特·艾略特','艾略特','Elliot']),
 (12,'欧内斯特·布朗','Ernest Brown',['欧内斯特·布朗','Ernest Brown']),
 (13,'戴维·马杰森','David Margesson',['马杰森','Margesson']),
 (14,'昆廷·霍格','Quintin McGarel Hogg',['昆廷·霍格','霍格','Hogg']),
 (15,'维克托·沃伦德','Victor Alexander George Anthony Warrender',['沃伦德','Warrender']),
 (16,'罗伯特·哈德森','Robert Spear Hudson',['罗伯特·哈德森','哈德森','Hudson']),
 (17,'温斯顿·丘吉尔','Winston Leonard Spencer Churchill',['丘吉尔','Churchill']),
 (18,'安东尼·艾登','Robert Anthony Eden',['安东尼·艾登','艾登','Eden']),
 (19,'利奥·艾默里','Leopold Charles Maurice Stennett Amery',['艾默里','Amery']),
 (20,'哈罗德·麦克米伦','Maurice Harold Macmillan',['麦克米伦','Macmillan']),
 (21,'乔治·劳埃德','George Ambrose Lloyd',['乔治·劳埃德','Lloyd']),
 (22,'阿尔弗雷德·达夫·库珀','Alfred Duff Cooper',['达夫·库珀','Duff Cooper','库珀']),
 (23,'约翰·卡特兰德','John Ronald Hamilton Cartland',['卡特兰德','Cartland']),
 (24,'维克托·卡扎莱特','Victor Alexander Cazalet',['卡扎莱特','Cazalet']),
 (25,'布伦丹·布雷肯','Brendan Rendall Bracken',['布雷肯','Bracken']),
 (26,'罗伯特·布思比','Robert John Graham Boothby',['布思比','Boothby']),
 (27,'克莱门特·艾德礼','Clement Richard Attlee',['艾德礼','Attlee']),
 (28,'亚瑟·格林伍德','Arthur Greenwood',['格林伍德','Greenwood']),
 (29,'查尔斯·爱德华兹','Charles Edwards',['查尔斯·爱德华兹','Edwards']),
 (30,'菲利普·诺埃尔-贝克','Philip John Noel-Baker',['诺埃尔-贝克','Noel-Baker']),
 (31,'阿尔伯特·亚历山大','Albert Victor Alexander',['阿尔伯特·亚历山大','A. V. Alexander']),
 (32,'斯塔福德·克里普斯','Stafford Cripps',['克里普斯','Cripps']),
 (33,'安奈林·比万','Aneurin Bevan',['比万','Bevan']),
 (34,'托马斯·约翰斯顿','Thomas Johnston',['托马斯·约翰斯顿','Johnston']),
 (35,'休·道尔顿','Hugh Dalton',['道尔顿','Dalton']),
 (36,'赫伯特·莫里森','Herbert Stanley Morrison',['莫里森','Morrison']),
 (37,'欧内斯特·贝文','Ernest Bevin',['贝文','Bevin']),
 (38,'弗里德里克·贝林杰','Frederick Bellenger',['贝林杰','Bellenger']),
 (39,'哈罗德·尼科尔森','Harold Nicolson',['尼科尔森','Nicolson']),
 (40,'阿奇博尔德·辛克莱','Archibald Sinclair',['辛克莱','Sinclair']),
 (41,'戴维·劳合·乔治','David Lloyd George',['劳合·乔治','Lloyd George']),
 (42,'珀西·哈里斯','Percy Harris',['珀西·哈里斯','Harris']),
 (43,'戈罗努伊·欧文','Goronwy Owen',['戈罗努伊·欧文','Goronwy']),
 (44,'查尔斯·克尔','Charles Kerr',['查尔斯·克尔','Kerr']),
 (45,'杰弗里·莎士比亚','Geoffrey Shakespeare',['莎士比亚','Shakespeare']),
 (46,'罗伯特·奥尼尔',"Robert William Hugh O'Neill",['奥尼尔',"O’Neill"]),
 (47,'詹姆斯·马克斯顿','James Maxton',['马克斯顿','Maxton']),
]

res=[]
for num,cn,en,aliases in people:
    total=0; hits={}
    for a in aliases:
        c=len(re.findall(re.escape(a), text))
        hits[a]=c; total+=c
    res.append((num,cn,total,hits))

for num,cn,total,hits in res:
    print(f'{num:03d} {cn:14s} total={total:4d}  {hits}')
