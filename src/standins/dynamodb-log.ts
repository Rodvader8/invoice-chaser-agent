import { PutCommand, type DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { queryAll } from "../storage/dynamodb.js";
import type { MessageLog, OutboxMessage } from "./outbox.js";

/** The stand-in outbox's messages in the app's DynamoDB table: pk OUTBOX#<clientRef>, sk MSG#<id>. */
export class DynamoDbMessageLog implements MessageLog {
  constructor(
    private readonly doc: DynamoDBDocumentClient,
    private readonly tableName: string,
  ) {}

  async append(message: OutboxMessage): Promise<void> {
    await this.doc.send(
      new PutCommand({
        TableName: this.tableName,
        Item: { pk: `OUTBOX#${message.clientRef}`, sk: `MSG#${message.id}`, ...message },
      }),
    );
  }

  async byRef(clientRef: string): Promise<OutboxMessage[]> {
    const items = await queryAll(this.doc, this.tableName, `OUTBOX#${clientRef}`, "MSG#");
    return items.map((i) => ({
      id: i.id as string,
      clientRef: i.clientRef as string,
      channel: i.channel as OutboxMessage["channel"],
      to: i.to as string,
      subject: i.subject as string,
      body: i.body as string,
    }));
  }
}
