export declare function slackPayloadOf(text:string):Record<string,unknown>|null;
export declare function slackMessage(payload:Record<string,unknown>):{markup:string;cards:unknown[]}|'invalid_payload'|'no_text'|'too_many_attachments'|'msg_too_long';
