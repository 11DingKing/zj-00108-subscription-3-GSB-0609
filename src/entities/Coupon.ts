import { Entity, PrimaryGeneratedColumn, Column, ManyToMany, JoinTable } from "typeorm";
import { Plan } from "./Plan";

export enum CouponType {
  FIXED = "fixed",
  PERCENTAGE = "percentage",
}

@Entity()
export class Coupon {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ type: "text", unique: true })
  code: string;

  @Column({
    type: "simple-enum",
    enum: CouponType,
  })
  type: CouponType;

  @Column({ type: "decimal", precision: 10, scale: 2 })
  value: number;

  @Column({ type: "int", default: 0 })
  maxUses: number;

  @Column({ type: "int", default: 0 })
  usedCount: number;

  @Column({ type: "datetime", nullable: true })
  expiresAt: Date | null;

  @ManyToMany(() => Plan)
  @JoinTable()
  applicablePlans: Plan[];

  @Column({ type: "boolean", default: true })
  isActive: boolean;

  @Column({ type: "datetime", default: () => "CURRENT_TIMESTAMP" })
  createdAt: Date;

  isExpired(): boolean {
    if (!this.expiresAt) return false;
    return new Date() > this.expiresAt;
  }

  isUsable(): boolean {
    if (!this.isActive) return false;
    if (this.isExpired()) return false;
    if (this.maxUses > 0 && this.usedCount >= this.maxUses) return false;
    return true;
  }

  calculateDiscount(amount: number): number {
    if (this.type === CouponType.FIXED) {
      return Math.min(this.value, amount);
    }
    return Number(((amount * this.value) / 100).toFixed(2));
  }
}
