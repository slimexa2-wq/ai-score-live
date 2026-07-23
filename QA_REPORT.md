# QA 独立验证报告（严过关）

服务地址： http://127.0.0.1:3100
测试时间： 2026-07-23T02:17:04.970Z

## 汇总
- 总计：24 ｜ 通过：24 ｜ 失败：0

## 逐条结果
1. ✅ **启动健康·GET / 200 且含「AI竞赛」**  
   status=200, contentType=text/html; charset=utf-8, includes('AI竞赛')=true
2. ✅ **启动健康·GET /live 200**  
   status=200, contentType=text/html; charset=utf-8
3. ✅ **启动健康·控制台打印评委URL/大屏URL**  
   日志含评委/大屏URL=true
4. ✅ **启动健康·生成 qrcode.png 且为合法PNG**  
   exists=true, pngHeader=true
5. ✅ **合法提交·200 {ok:true,record}**  
   status=200, ok=true
6. ✅ **合法提交·weightedScore 计算正确(手算 8.20)**  
   返回=8.2, 期望=8.2
7. ✅ **合法提交·stats.totalRecords=1**  
   totalRecords=1
8. ✅ **聚合·totalRecords=6**  
   返回=6, 期望=6
9. ✅ **聚合·totalWorks=2**  
   返回=2, 期望=2
10. ✅ **聚合·totalJudges=6(去重 judgeName|judgeType)**  
   返回=6, 期望=6
11. ✅ **聚合·WorkA leaderAvg=(8.20+6.30)/2=7.25**  
   返回=7.25, 期望=7.25, leaderCount=2
12. ✅ **聚合·WorkA publicAvg=7.30**  
   返回=7.3, 期望=7.3, publicCount=1
13. ✅ **聚合·WorkA finalScore=leaderAvg*0.5+publicAvg*0.5**  
   返回=7.28, 期望=7.28
14. ✅ **聚合·WorkB leaderAvg=(10+8)/2=9.00**  
   返回=9, 期望=9.00
15. ✅ **聚合·WorkB publicAvg=6.00**  
   返回=6, 期望=6.00
16. ✅ **聚合·WorkB finalScore=9*0.5+6*0.5=7.50**  
   返回=7.5, 期望=7.50
17. ✅ **聚合·works 按 finalScore 降序**  
   顺序=[保安子公司(勇敢牛牛队):7.5, 人力资源部(雪梨队):7.28]
18. ✅ **聚合·去重：复用评委不增加 totalJudges(仍=6,totalRecords=7)**  
   totalJudges=6(期望6), totalRecords=7(期望7)
19. ✅ **非法输入·全部返回 400 {ok:false,error}**  
   缺字段(无innovation): 400 ok:false (innovation 必须为 1-10 的整数) | judgeType 非法(admin): 400 ok:false (judgeType 必须为 "leader" 或 "public") | 四维越界(innovation=11): 400 ok:false (innovation 必须为 1-10 的整数) | 四维越界(innovation=0): 400 ok:false (innovation 必须为 1-10 的整数) | 非整数(innovation=5.5): 400 ok:false (innovation 必须为 1-10 的整数) | 非数字字符串(innovation="abc"): 400 ok:false (innovation 必须为 1-10 的整数) | 空对象: 400 ok:false (judgeType 必须为 "leader" 或 "public")
20. ✅ **非法输入·未写入数据(totalRecords 不变)**  
   提交前=7, 提交后=7
21. ✅ **UTF-8·中文 judgeName/workName 正确无乱码**  
   提交 status=200, 回查 recent 含「中文测试队伍甲」/测试评委张三=true
22. ✅ **二维码·GET /api/qrcode 返回 image/png 且合法PNG头**  
   contentType=image/png, header=89504e47
23. ✅ **SSE·连接即收到 event:stats 快照**  
   initialSnapshotReceived=true
24. ✅ **SSE·新评分后数秒内收到含新数据的 stats 事件**  
   pushReceived=true, newPostStatus=200