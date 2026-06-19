import { Queue } from "bullmq";
import connection from "./redis.js";

const ticketQueue = new Queue("ticketQueue", {
  connection,
});

export default ticketQueue;