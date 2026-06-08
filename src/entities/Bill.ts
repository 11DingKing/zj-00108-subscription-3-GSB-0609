import { Entity, PrimaryGeneratedColumn, Column, ManyToOne } from "typeorm";
import { User } from "./User";
import { Subscription } from "./Subscription";
import { Plan } from "./Plan";
import { Coupon } from "./Coupon";

export enum BillStatus {
  PENDING = "pending",
  PAID = "paid",
  FAILED = "failed",
  REFUNDED = "refunded",
}

@Entity()
export class Bill {
  @PrimaryGeneratedColumn()
  id: number;

  @ManyToOne(() => User, (user) => user.bills)
  user: User;

  @ManyToOne(() => Subscription, (subscription) => subscription.bills)
  subscription: Subscription;

  @ManyToOne(() => Plan)
  plan: Plan;

  @Column({ type: "decimal", precision: 10, scale: 2 })
  amount: number;

  @Column({ type: "decimal", precision: 10, scale: 2, default: 0 })
  discountAmount: number;

  @ManyToOne(() => Coupon, { nullable: true })
  coupon: Coupon | null;

  @Column({
    type: "simple-enum",
    enum: BillStatus,
    default: BillStatus.PENDING,
  })
  status: BillStatus;

  @Column({ type: "text", nullable: true })
  description: string;

  @Column({ type: "datetime", nullable: true })
  paidAt: Date;

  @Column({ type: "datetime", default: () => "CURRENT_TIMESTAMP" })
  createdAt: Date;
}
