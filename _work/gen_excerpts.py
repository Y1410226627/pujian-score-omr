# -*- coding: utf-8 -*-
import re, os, json

ROOT = r'D:\桌面\战前下议院人物档案_20261020'
XLSX = '至暗时刻-战前英下议院-席位分配表.xlsx'
BGF = '历史特殊委员会 英国下议院 背景文件（注释版·电子书）.txt'
BGP = r'D:\桌面\历史资料\历史特殊委员会 英国下议院 背景文件（注释版·电子书）.txt'

# (num, cn, en_file, en_disp, party, office, seat, region, other, votes, rep, school, xlrow)
P = [
 (1,'莱斯利·霍尔-贝利沙','Leslie_Hore-Belisha','Leslie Hore-Belisha','国民自由党','陆军大臣','Plymouth Devonport（德文郡普利茅斯）','England','',6,'余晨翔','中国社会科学院大学',7),
 (2,'内维尔·张伯伦','Arthur_Neville_Chamberlain','Arthur Neville Chamberlain','保守党绥靖派','保守党党魁、首相','Birmingham Edgbaston(伯明翰埃奇巴斯顿)','England','',40,'张为康','首都医科大学',2),
 (3,'塞缪尔·霍尔','Samuel_John_Gurney_Hoare','Samuel John Gurney Hoare','保守党绥靖派','内政大臣','Chelsea(切尔西)','England','',28,'彭婧','中国人民警察大学',3),
 (4,'哈利法克斯勋爵','Edward_Frederick_Lindley_Wood','Edward Frederick Lindley Wood','保守党绥靖派','外交大臣','上院贵族','','',34,'李建辰','中国社会科学院大学',4),
 (5,'约翰·西蒙','John_Allsebrook_Simon','John Allsebrook Simon','国民自由党','国民自由党党魁、财政大臣','Spen Valley（斯彭谷）','England','',9,'崔雨昕','中国人民警察大学',5),
 (6,'奥利弗·斯坦利','Oliver_Frederick_George_Stanley','Oliver Frederick George Stanley','保守党绥靖派','贸易委员会主席','Westmorland（威斯特莫兰）','England','',16,'黄泽松','中国人民警察大学',6),
 (7,'斯坦霍普伯爵','James_Richard_Stanhope','James Richard Stanhope','保守党绥靖派','第一海军大臣','上院贵族','','',16,'赵一彤','首都师范大学',8),
 (8,'霍华德·金斯利·伍德','Howard_Kingsley_Wood','Howard Kingsley Wood','保守党绥靖派','空军大臣','Woolwich West（西伍尔维奇）','England','',20,'徐麒森','中国社会科学院大学',9),
 (9,'马尔科姆·麦克唐纳','Malcolm_Macdonald','Malcolm Macdonald','国民工党','国民工党党魁、殖民地事务大臣、自治领事务大臣','Ross and Cromarty','Scotland','',5,'陈锐','中国人民警察大学',10),
 (10,'托马斯·英斯基普','Thomas_Walker_Hobart_Inskip','Thomas Walker Hobart Inskip','保守党绥靖派','国防协调大臣','Fareham（费勒姆）','England','',23,'宋弈灵','北京理工大学',11),
 (11,'沃尔特·艾略特','Walter_Elliot','Walter Elliot','保守党苏格兰分支，苏格兰保守与统一党；绥靖派','卫生大臣','Glasgow Kelvingrove(格拉斯哥凯尔文格罗夫)','Scotland','',23,'周安琪','中央财经大学',12),
 (12,'欧内斯特·布朗','Ernest_Brown','Ernest Brown','国民自由党','劳工大臣','Leith','Scotland','',6,'沈天娇','北京师范大学第二附属中学',13),
 (13,'戴维·马杰森','David_Margesson','David Margesson','保守党绥靖派','保守党党鞭','Rugby（拉格比）','England','',30,'侯雅涵','北京工商大学',15),
 (14,'昆廷·霍格','Quintin_McGarel_Hogg','Quintin McGarel Hogg','保守党绥靖派','无','Oxford（牛津）','England','',14,'汤昊锦','北京第二外国语学院',16),
 (15,'维克托·沃伦德','Victor_Alexander_George_Anthony_Warrender','Victor Alexander George Anthony Warrender','保守党绥靖派','无','Grantham（格兰瑟姆）','England','',12,'马海苧','北京服装学院',17),
 (16,'罗伯特·哈德森','Robert_Spear_Hudson','Robert Spear Hudson','保守党绥靖派；反张伯伦派','枢密院顾问官','Southport(绍斯波特)','England','',13,'宋婧祎','北京服装学院',18),
 (17,'温斯顿·丘吉尔','Winston_Leonard_Spencer_Churchill','Winston Leonard Spencer Churchill','保守党反绥靖派','无','Epping（埃平）','England','',14,'李开锐','山西大学',19),
 (18,'安东尼·艾登','Robert_Anthony_Eden','Robert Anthony Eden','保守党反绥靖派','无','Warwick and Leamington（沃里克和雷明顿）','England','',16,'李若源','上海财经大学',20),
 (19,'利奥·艾默里','Leopold_Charles_Maurice_Stennett_Amery','Leopold Charles Maurice Stennett Amery','保守党反绥靖派','无','Birmingham Sparkbrook（伯明翰斯帕克布鲁克）','England','',11,'廖畅','首都师范大学',21),
 (20,'哈罗德·麦克米伦','Maurice_Harold_Macmillan','Maurice Harold Macmillan','保守党反绥靖派','无','Stockton-on-Tees（斯托克顿-蒂斯）','England','',10,'武政熠','北京理工大学',22),
 (21,'乔治·劳埃德','George_Ambrose_Lloyd','George Ambrose Lloyd','保守党反绥靖派','枢密院顾问官','上院贵族','','英国文化协会主席',9,'张煜成','中国人民警察大学',23),
 (22,'阿尔弗雷德·达夫·库珀','Alfred_Duff_Cooper','Alfred Duff Cooper','保守党反绥靖派','无',"Westminster St George's（威斯敏斯特圣乔治）",'England','',10,'冯俊瑞','北京金融科技学院',24),
 (23,'约翰·卡特兰德','John_Ronald_Hamilton_Cartland','John Ronald Hamilton Cartland','保守党反绥靖派','无',"Birmingham King's Norton(伯明翰国王诺顿)",'England','',9,'黄柏源','北京第二外国语学院',25),
 (24,'维克托·卡扎莱特','Victor_Alexander_Cazalet','Victor Alexander Cazalet','保守党反绥靖派','无','Chippenham(奇彭纳姆)','England','',9,'邱静怡','北京金融科技学院',26),
 (25,'布伦丹·布雷肯','Brendan_Rendall_Bracken','Brendan Rendall Bracken','保守党反绥靖派','无','Paddington North（伦敦北帕丁顿）','England','',9,'张文青','北京金融科技学院',27),
 (26,'罗伯特·布思比','Robert_John_Graham_Boothby','Robert John Graham Boothby','保守党反绥靖派','无','Aberdeen and Kincardine East (阿伯丁和因弗内斯东部)','Scotland','',9,'赵子岳','对外经济贸易大学',28),
 (27,'克莱门特·艾德礼','Clement_Richard_Attlee','Clement Richard Attlee','工党右派','工党党魁','Stepney Limehouse','England','',22,'马铭天宇','郑州大学',29),
 (28,'亚瑟·格林伍德','Arthur_Greenwood','Arthur Greenwood','工党中间派','工党副党魁','Wakefield','England','',15,'陈朝阳','首都师范大学',30),
 (29,'查尔斯·爱德华兹','Charles_Edwards','Charles Edwards','工党中间派','工党党鞭','Bedwellty','Wales','',19,'龚振雄','天津外国语大学',31),
 (30,'菲利普·诺埃尔-贝克','Philip_John_Noel-Baker','Philip John Noel-Baker','工党中间派','无','Derby(two members)','England','',8,'王悦璇','北京金融科技学院',32),
 (31,'阿尔伯特·亚历山大','Albert_Victor_Alexander','Albert Victor Alexander','工党中间派','无','Sheffield Hillsborough','England','',8,'张澳宇','北京金融科技学院',33),
 (32,'斯塔福德·克里普斯','Stafford_Cripps','Stafford Cripps','工党左派','无','Bristol East','England','',10,'韩易辰','南开大学',34),
 (33,'安奈林·比万','Aneurin_Bevan','Aneurin Bevan','工党左派','无','Ebbw Vale','Wales','',9,'朱俊丞','中国社会科学院大学',35),
 (34,'托马斯·约翰斯顿','Thomas_Johnston','Thomas Johnston','工党左派','无','Stirlingshire and Clackmannanshire Western','Scotland','',8,'张恒瑞','北京外国语大学',36),
 (35,'休·道尔顿','Hugh_Dalton','Hugh Dalton','工党右派','全国执行委员会主席（架空）','Bishop Auckland','England','',18,'徐康凯','北京外国语大学',37),
 (36,'赫伯特·莫里森','Herbert_Stanley_Morrison','Herbert Stanley Morrison','工党右派','无','Hackney South','England','',14,'史安毅','首都师范大学',38),
 (37,'欧内斯特·贝文','Ernest_Bevin','Ernest Bevin','工党右派','无','Wandsworth Central （架空）','England','英国职工大会主席（架空）',15,'姚雨曈','中国人民警察大学',39),
 (38,'弗里德里克·贝林杰','Frederick_Bellenger','Frederick Bellenger','工党右派','无','Bassetlaw','England','',8,'张菀凌','北京第二外国语学院',40),
 (39,'哈罗德·尼科尔森','Harold_Nicolson','Harold Nicolson','国民工党','无','Leicester West','England','',3,'刘敬齐','中国人民警察大学',41),
 (40,'阿奇博尔德·辛克莱','Archibald_Sinclair','Archibald Sinclair','自由党','自由党党魁','Caernarvon Boroughs','Wales','',6,'张彦玺','首都师范大学',42),
 (41,'戴维·劳合·乔治','David_Lloyd_George','David Lloyd George','自由党','无','Caithness and Sutherland','England','',6,'王梓安','北京理工大学',43),
 (42,'珀西·哈里斯','Percy_Harris','Percy Harris','自由党','自由党党鞭','Bethnal Green South West','England','',6,'余浩翔','天津外国语大学',44),
 (43,'戈罗努伊·欧文','Goronwy_Owen','Goronwy Owen','自由党','无','Caernarvonshire','Wales','',3,'史冯媛','中国社会科学院大学',45),
 (44,'查尔斯·克尔','Charles_Kerr','Charles Kerr','国民自由党','国民自由党党鞭','Montrose Burghs','Scotland','',8,'禚煜卿','北京服装学院',46),
 (45,'杰弗里·莎士比亚','Geoffrey_Shakespeare','Geoffrey Shakespeare','国民自由党','无','Norwich','England','',4,'马佳妮','首都师范大学',47),
 (46,'罗伯特·奥尼尔',"Robert_William_Hugh_O'Neill",'Robert William Hugh O’Neill','阿尔斯特统一党','保守党1922委员会主席','Antrim','Northern Ireland','',11,'阎玺名','首都师范大学',48),
 (47,'詹姆斯·马克斯顿','James_Maxton','James Maxton','独立工党','独立工党党魁','Glasgow Bridgeton','Scotland','',4,'张兴锴','天津外国语大学',49),
]

ALIAS = {
 '莱斯利·霍尔-贝利沙':['霍尔-贝利沙','Hore-Belisha','贝利沙'],
 '内维尔·张伯伦':['张伯伦','Chamberlain'],
 '塞缪尔·霍尔':['塞缪尔·霍尔','Hoare'],
 '哈利法克斯勋爵':['哈利法克斯','Halifax'],
 '约翰·西蒙':['西蒙','Simon'],
 '奥利弗·斯坦利':['斯坦利','Stanley'],
 '斯坦霍普伯爵':['斯坦霍普','Stanhope'],
 '霍华德·金斯利·伍德':['金斯利·伍德','Kingsley Wood'],
 '马尔科姆·麦克唐纳':['马尔科姆·麦克唐纳','Macdonald'],
 '托马斯·英斯基普':['英斯基普','Inskip'],
 '沃尔特·艾略特':['沃尔特·艾略特','艾略特','Elliot'],
 '欧内斯特·布朗':['欧内斯特·布朗','Ernest Brown'],
 '戴维·马杰森':['马杰森','Margesson'],
 '昆廷·霍格':['昆廷·霍格','霍格','Hogg'],
 '维克托·沃伦德':['沃伦德','Warrender'],
 '罗伯特·哈德森':['罗伯特·哈德森','哈德森','Hudson'],
 '温斯顿·丘吉尔':['丘吉尔','Churchill'],
 '安东尼·艾登':['安东尼·艾登','艾登','Eden'],
 '利奥·艾默里':['艾默里','Amery'],
 '哈罗德·麦克米伦':['麦克米伦','Macmillan'],
 '乔治·劳埃德':['乔治·劳埃德','劳埃德','Lloyd'],
 '阿尔弗雷德·达夫·库珀':['达夫·库珀','Duff Cooper','库珀'],
 '约翰·卡特兰德':['卡特兰德','Cartland'],
 '维克托·卡扎莱特':['卡扎莱特','Cazalet'],
 '布伦丹·布雷肯':['布雷肯','Bracken'],
 '罗伯特·布思比':['布思比','Boothby'],
 '克莱门特·艾德礼':['艾德礼','Attlee'],
 '亚瑟·格林伍德':['格林伍德','Greenwood'],
 '查尔斯·爱德华兹':['查尔斯·爱德华兹','Edwards'],
 '菲利普·诺埃尔-贝克':['诺埃尔-贝克','Noel-Baker'],
 '阿尔伯特·亚历山大':['阿尔伯特·亚历山大','A. V. Alexander'],
 '斯塔福德·克里普斯':['克里普斯','Cripps'],
 '安奈林·比万':['比万','Bevan'],
 '托马斯·约翰斯顿':['托马斯·约翰斯顿','约翰斯顿','Johnston'],
 '休·道尔顿':['道尔顿','Dalton'],
 '赫伯特·莫里森':['莫里森','Morrison'],
 '欧内斯特·贝文':['贝文','Bevin'],
 '弗里德里克·贝林杰':['贝林杰','Bellenger'],
 '哈罗德·尼科尔森':['尼科尔森','Nicolson'],
 '阿奇博尔德·辛克莱':['辛克莱','Sinclair'],
 '戴维·劳合·乔治':['劳合·乔治','Lloyd George'],
 '珀西·哈里斯':['珀西·哈里斯','哈里斯','Harris'],
 '戈罗努伊·欧文':['戈罗努伊·欧文','欧文','Owen'],
 '查尔斯·克尔':['查尔斯·克尔','克尔','Kerr'],
 '杰弗里·莎士比亚':['莎士比亚','Shakespeare'],
 '罗伯特·奥尼尔':['奥尼尔'],
 '詹姆斯·马克斯顿':['马克斯顿','Maxton'],
}

text = open(BGP, encoding='utf-8', errors='replace').read()
lines = text.split('\n')

os.makedirs(os.path.join(ROOT,'02_原始摘录','席位分配表'), exist_ok=True)
os.makedirs(os.path.join(ROOT,'02_原始摘录','背景文件'), exist_ok=True)

stats={}
for (num,cn,enf,end,party,office,seat,region,other,votes,rep,school,xlrow) in P:
    idx = f'{num:03d}'
    # 席位分配表 excerpt
    row = []
    row.append(f'# {idx}_{cn}_{enf}')
    row.append('')
    row.append(f'- 文献：{XLSX}（简称：席位分配表）')
    row.append(f'- 文献类型：二手（推演模拟用席位分配表，含架空设定）')
    row.append(f'- 位置：工作表1，第{xlrow}行（A{xlrow}:J{xlrow}）')
    row.append('')
    row.append('## 底本原文字段（逐格照录）')
    row.append('')
    row.append('| 字段 | 原值 |')
    row.append('| --- | --- |')
    row.append(f'| 姓名 | {cn} |')
    row.append(f'| Name | {end} |')
    row.append(f'| 党派 | {party} |')
    row.append(f'| 党职/公职 | {office} |')
    row.append(f'| 选区 | {seat} |')
    row.append(f'| 行政大区 | {region} |')
    row.append(f'| 其他职务 | {other} |')
    row.append(f'| 票权 | {votes} |')
    row.append(f'| 代表 | {rep} |')
    row.append(f'| 学校 | {school} |')
    row.append('')
    row.append('> 说明：【票权／代表／学校】为推演模拟元数据，非史实；“党派”栏为底本给定阵营标签，原样引用。')
    open(os.path.join(ROOT,'02_原始摘录','席位分配表',f'{idx}_{cn}_{enf}.md'),'w',encoding='utf-8',newline='\n').write('\n'.join(row)+'\n')

    # 背景文件 excerpt
    aliases = ALIAS.get(cn, [cn])
    hit = []
    for i,l in enumerate(lines):
        if any(a in l for a in aliases):
            hit.append(i)
    if hit:
        keep=set()
        for i in hit:
            for j in range(max(0,i-2), min(len(lines), i+3)):
                keep.add(j)
        keep = sorted(keep)
        body=[]
        prev=-2
        for j in keep:
            if j != prev+1:
                body.append('……')
            body.append(lines[j].strip())
            prev=j
    out=[]
    out.append(f'# {idx}_{cn}_{enf}')
    out.append('')
    out.append(f'- 文献：{BGF}（简称：背景文件）')
    out.append(f'- 文献类型：二手（模联历史特殊委员会背景文件·注释版，原文未改，注释另加）')
    out.append(f'- 命中行数：{len(hit)}（全文共 {len(lines)} 行，{len(text)} 字符）')
    out.append(f'- 位置：见下文各段所在行号标注')
    out.append('')
    if hit:
        out.append('## 摘录（按原文行序，含上下文各2行；“……”表示跨段跳跃）')
        out.append('')
        out.append('```text')
        out.extend(body)
        out.append('```')
    else:
        out.append('## 摘录')
        out.append('')
        out.append('文献中未涉及（全文未检出该人物姓名或其英文姓氏）。')
    open(os.path.join(ROOT,'02_原始摘录','背景文件',f'{idx}_{cn}_{enf}.md'),'w',encoding='utf-8',newline='\n').write('\n'.join(out)+'\n')
    stats[idx]={'cn':cn,'bg_hits':len(hit)}

json.dump(stats, open(os.path.join(ROOT,'99_处理状态','_excerpt_stats.json'),'w',encoding='utf-8'), ensure_ascii=False, indent=1)
print('席位居:', len(os.listdir(os.path.join(ROOT,'02_原始摘录','席位分配表'))))
print('背景文件:', len(os.listdir(os.path.join(ROOT,'02_原始摘录','背景文件'))))
print('零命中:', [k for k,v in stats.items() if v['bg_hits']==0])
