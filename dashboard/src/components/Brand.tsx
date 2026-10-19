import { Shield } from "lucide-react";

export const Brand = () => (
  <div className="brand">
    <span className="brand-symbol">
      <Shield size={23} strokeWidth={1.7} />
    </span>
    <div>
      <strong>
        ZT<span> / </span>ServerOps
      </strong>
      <small>INFRASTRUCTURE CONSOLE</small>
    </div>
  </div>
);
