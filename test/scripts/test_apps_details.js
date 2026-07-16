/**
    * 异步获取设备应用详细信息列表的测试脚本 (包含可读中文名称、版本、是否系统应用等)
    * 
    * 运行方式:
    *   node --env-file=pc/.env test/scripts/test_apps_details.js
    */
   
   const PC_IP = process.env.PC_IP;
   if (!PC_IP) {
     console.error('[ERROR] Environment variable PC_IP is required. Run with --env-file=pc/.env or export PC_IP.');
     process.exit(1);
   }
   const PORT = process.env.PORT;
   if (!PORT) {
     console.error('[ERROR] Environment variable PORT is required. Run with --env-file=pc/.env or export PORT.');
     process.exit(1);
   }
   
   async function run() {
     const url = `http://${PC_IP}:${PORT}/api/apps/details-task`;
     console.log(`[APPS DETAILS TEST] Dispatching task to query detailed apps list to ${url}...`);
   
     try {
       const response = await fetch(url, {
         method: 'POST'
       });
   
       if (!response.ok) {
         throw new Error(`HTTP error! status: ${response.status}`);
       }
   
       const result = await response.json();
       console.log('[APPS DETAILS TEST] Task created. Response:', result);
       
       if (result.success && result.taskId) {
         const taskId = result.taskId;
         console.log(`[APPS DETAILS TEST] Polling status for task: ${taskId}`);
         
         const interval = setInterval(async () => {
           try {
             const statusRes = await fetch(`http://${PC_IP}:${PORT}/api/tasks/${taskId}`);
             if (!statusRes.ok) return;
   
             const statusData = await statusRes.json();
             if (statusData.success && statusData.task) {
               const status = statusData.task.status;
               
               if (status !== 'EXECUTING') {
                 console.log(`\n========================================`);
                 console.log(`[APPS DETAILS TEST] Task completed with status: ${status}`);
                 
                 const rawMessage = statusData.task.message;
                 try {
                   const details = JSON.parse(rawMessage);
                   console.log(`[APPS DETAILS TEST] Retrieved ${details.length} applications:`);
                   // 使用 console.table 美化显示前 20 条，避免控制台溢出
                   console.table(details.slice(0, 20));
                   if (details.length > 20) {
                     console.log(`... and ${details.length - 20} more applications.`);
                   }
                 } catch (e) {
                   console.log(`[APPS DETAILS TEST] Raw Output:\n`, rawMessage);
                 }
                 console.log(`========================================\n`);
                 clearInterval(interval);
               } else {
                 process.stdout.write('.');
               }
             }
           } catch (err) {
             console.error('[APPS DETAILS TEST] Polling error:', err.message);
           }
         }, 1500);
       }
   
     } catch (error) {
       console.error('[APPS DETAILS TEST] Failed:', error.message);
     }
   }
   
   run();
