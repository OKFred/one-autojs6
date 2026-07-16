/**
    * 异步获取设备应用包名列表的测试脚本
    * 
    * 运行方式:
    *   node --env-file=pc/.env test/scripts/test_apps_list.js
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
     const url = `http://${PC_IP}:${PORT}/api/apps/task?type=third`;
     console.log(`[APPS LIST TEST] Dispatching task to query third-party apps to ${url}...`);
   
     try {
       const response = await fetch(url, {
         method: 'POST'
       });
   
       if (!response.ok) {
         throw new Error(`HTTP error! status: ${response.status}`);
       }
   
       const result = await response.json();
       console.log('[APPS LIST TEST] Task created. Response:', result);
       
       if (result.success && result.taskId) {
         const taskId = result.taskId;
         console.log(`[APPS LIST TEST] Polling status for task: ${taskId}`);
         
         const interval = setInterval(async () => {
           try {
             const statusRes = await fetch(`http://${PC_IP}:${PORT}/api/tasks/${taskId}`);
             if (!statusRes.ok) return;
   
             const statusData = await statusRes.json();
             if (statusData.success && statusData.task) {
               const status = statusData.task.status;
               
               if (status !== 'EXECUTING') {
                 console.log(`\n========================================`);
                 console.log(`[APPS LIST TEST] Task completed with status: ${status}`);
                 console.log(`[APPS LIST TEST] Package names returned:\n`);
                 
                 const rawMessage = statusData.task.message;
                 console.log(rawMessage);
                 console.log(`========================================\n`);
                 clearInterval(interval);
               } else {
                 process.stdout.write('.');
               }
             }
           } catch (err) {
             console.error('[APPS LIST TEST] Polling error:', err.message);
           }
         }, 1000);
       }
   
     } catch (error) {
       console.error('[APPS LIST TEST] Failed:', error.message);
     }
   }
   
   run();
