(function() {
    try {
        var smsFilter = new android.content.IntentFilter("android.provider.Telephony.SMS_RECEIVED");
        var receiver = new android.content.BroadcastReceiver({
            onReceive: function(ctx, intent) {
                try {
                    var bundle = intent.getExtras();
                    if (bundle != null) {
                        var pdus = bundle.get("pdus");
                        var format = bundle.getString("format");
                        if (pdus != null) {
                            for (var i = 0; i < pdus.length; i++) {
                                var pdu = pdus[i];
                                var sms = format ? 
                                    android.telephony.SmsMessage.createFromPdu(pdu, format) : 
                                    android.telephony.SmsMessage.createFromPdu(pdu);
                                appendEvent("sms", {
                                    address: String(sms.getOriginatingAddress()),
                                    body: String(sms.getMessageBody()),
                                    smsTimestamp: sms.getTimestampMillis()
                                });
                            }
                        }
                    }
                } catch (err) {
                    console.error("SMS receiver error: " + err);
                }
            }
        });
        context.registerReceiver(receiver, smsFilter);
    } catch (e) {
        console.error("SMS observer setup error: " + e);
    }
})();
